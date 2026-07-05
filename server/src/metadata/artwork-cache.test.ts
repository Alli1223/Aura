import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  artworkCacheDir,
  ArtworkError,
  clearArtworkCache,
  evictArtworkCache,
  resolveArtwork,
  type ArtworkCacheOptions,
} from './artwork-cache.js';

// The cache module is exercised against a real temporary CONFIG_DIR and a
// real temporary media root. fetch is stubbed with genuine PNG buffers built
// by sharp, so decoding/resizing runs for real but no network is touched.

let configDir: string;
let mediaRoot: string;
let tempDir: string;

/** A real PNG of the given dimensions (a solid colour is enough to decode). */
function pngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } },
  })
    .png()
    .toBuffer();
}

function imageResponse(buffer: Buffer, contentType = 'image/png'): Response {
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(buffer.byteLength) },
  });
}

/** A fetch stub answering every call with the same response, counting calls. */
function stubbedFetch(response: Response): typeof fetch {
  return vi.fn(() => Promise.resolve(response.clone())) as unknown as typeof fetch;
}

function options(fetchImpl?: typeof fetch): ArtworkCacheOptions {
  return { configDir, mediaRoots: [mediaRoot], fetchImpl };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-artwork-'));
  configDir = path.join(tempDir, 'config');
  mediaRoot = path.join(tempDir, 'media');
  await mkdir(configDir, { recursive: true });
  await mkdir(mediaRoot, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe('resolveArtwork tmdb sources', () => {
  it('fetches once, resizes to the bucket width as webp, then serves from cache', async () => {
    const png = await pngBuffer(1000, 1500);
    const fetchImpl = stubbedFetch(imageResponse(png));

    const first = await resolveArtwork('tmdb:/poster.jpg', 'w400', options(fetchImpl));
    expect(first.contentType).toBe('image/webp');
    expect(first.filePath.endsWith('.webp')).toBe(true);

    const meta = await sharp(await readFile(first.filePath)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400); // resized down to the bucket width
    expect(meta.width).toBeLessThanOrEqual(400);

    // Second call is a cache hit: same file, no extra fetch.
    const second = await resolveArtwork('tmdb:/poster.jpg', 'w400', options(fetchImpl));
    expect(second.filePath).toBe(first.filePath);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes the original bytes through untouched for size=original', async () => {
    const png = await pngBuffer(640, 480);
    const fetchImpl = stubbedFetch(imageResponse(png));

    const resolved = await resolveArtwork('tmdb:/orig.jpg', 'original', options(fetchImpl));
    expect(resolved.contentType).toBe('image/png');
    expect(resolved.filePath.endsWith('.png')).toBe(true);
    expect(await readFile(resolved.filePath)).toEqual(png); // byte-exact passthrough
  });

  it('never upscales: a source smaller than the bucket keeps its size', async () => {
    const png = await pngBuffer(120, 180);
    const fetchImpl = stubbedFetch(imageResponse(png));

    const resolved = await resolveArtwork('tmdb:/small.jpg', 'w800', options(fetchImpl));
    const meta = await sharp(await readFile(resolved.filePath)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(120); // unchanged — withoutEnlargement
  });

  it('deduplicates concurrent requests for the same key into one fetch', async () => {
    const png = await pngBuffer(1000, 1500);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return imageResponse(png);
    }) as unknown as typeof fetch;

    const opts = options(fetchImpl);
    const a = resolveArtwork('tmdb:/dup.jpg', 'w400', opts);
    const b = resolveArtwork('tmdb:/dup.jpg', 'w400', opts);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.filePath).toBe(rb.filePath);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // single in-flight fetch shared
  });

  it('rejects source bytes that are not a decodable image', async () => {
    const fetchImpl = stubbedFetch(imageResponse(Buffer.from('this is not an image'), 'image/png'));

    await expect(resolveArtwork('tmdb:/bogus.jpg', 'w400', options(fetchImpl))).rejects.toMatchObject(
      { name: 'ArtworkError', code: 'NOT_AN_IMAGE' },
    );
    expect(existsSync(artworkCacheDir(configDir))).toBe(false); // nothing cached
  });

  it('rejects malformed tmdb URIs before any fetch (no host escape possible)', async () => {
    const fetchImpl = stubbedFetch(imageResponse(await pngBuffer(10, 10)));
    const malicious = [
      'tmdb:/../../etc/passwd',
      'tmdb://evil.example.com/x.jpg',
      'tmdb:/nested/dir/x.jpg',
      'tmdb:@evil.example.com/x.jpg',
      'tmdb:/poster.jpg?x=1',
      'tmdb:/poster',
    ];
    for (const uri of malicious) {
      await expect(resolveArtwork(uri, 'w400', options(fetchImpl))).rejects.toMatchObject({
        code: 'INVALID_SOURCE',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled(); // rejected before building any URL
  });

  it('does not leave a partial file behind when the fetch fails', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('nope', { status: 502 })),
    ) as unknown as typeof fetch;

    await expect(resolveArtwork('tmdb:/gone.jpg', 'w400', options(fetchImpl))).rejects.toMatchObject(
      { code: 'FETCH_FAILED' },
    );

    // No cache file and no stray tmp file anywhere under the cache root.
    const root = artworkCacheDir(configDir);
    if (existsSync(root)) {
      const strays: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else strays.push(full);
        }
      };
      await walk(root);
      expect(strays).toEqual([]);
    }

    // The failed key is cleared from the in-flight map, so a later success works.
    const fetchOk = stubbedFetch(imageResponse(await pngBuffer(500, 750)));
    const ok = await resolveArtwork('tmdb:/gone.jpg', 'w400', options(fetchOk));
    expect(ok.contentType).toBe('image/webp');
  });

  it('times out a slow fetch as FETCH_FAILED', async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    await expect(
      resolveArtwork('tmdb:/slow.jpg', 'w400', { ...options(fetchImpl), timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });
});

describe('resolveArtwork anilist sources', () => {
  // A real AniList CDN cover URL, exactly as the anime enricher stores it.
  const ANILIST_URL =
    'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.png';
  const ANILIST_URI = `anilist:${ANILIST_URL}`;

  it('fetches once, resizes to the bucket width as webp, then serves from cache', async () => {
    const png = await pngBuffer(1000, 1500);
    const fetchImpl = stubbedFetch(imageResponse(png));

    const first = await resolveArtwork(ANILIST_URI, 'w400', options(fetchImpl));
    expect(first.contentType).toBe('image/webp');
    expect(first.filePath.endsWith('.webp')).toBe(true);

    const meta = await sharp(await readFile(first.filePath)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400); // resized down to the bucket width

    // Second call is a cache hit: same file, no extra fetch.
    const second = await resolveArtwork(ANILIST_URI, 'w400', options(fetchImpl));
    expect(second.filePath).toBe(first.filePath);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches the exact AniList CDN URL carried by the URI (full-URL convention)', async () => {
    const response = imageResponse(await pngBuffer(500, 750));
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(response.clone()),
    );
    await resolveArtwork(ANILIST_URI, 'w400', options(fetchImpl as unknown as typeof fetch));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(ANILIST_URL);
  });

  it('passes the original bytes through untouched for size=original', async () => {
    const png = await pngBuffer(640, 480);
    const fetchImpl = stubbedFetch(imageResponse(png));

    const resolved = await resolveArtwork(ANILIST_URI, 'original', options(fetchImpl));
    expect(resolved.contentType).toBe('image/png');
    expect(resolved.filePath.endsWith('.png')).toBe(true);
    expect(await readFile(resolved.filePath)).toEqual(png); // byte-exact passthrough
  });

  it('never upscales: a source smaller than the bucket keeps its size', async () => {
    const png = await pngBuffer(120, 180);
    const fetchImpl = stubbedFetch(imageResponse(png));

    const resolved = await resolveArtwork(ANILIST_URI, 'w800', options(fetchImpl));
    const meta = await sharp(await readFile(resolved.filePath)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(120); // unchanged — withoutEnlargement
  });

  it('deduplicates concurrent requests for the same key into one fetch', async () => {
    const png = await pngBuffer(1000, 1500);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return imageResponse(png);
    }) as unknown as typeof fetch;

    const opts = options(fetchImpl);
    const a = resolveArtwork(ANILIST_URI, 'w400', opts);
    const b = resolveArtwork(ANILIST_URI, 'w400', opts);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra.filePath).toBe(rb.filePath);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // single in-flight fetch shared
  });

  it('refuses any URL outside the AniList CDN allowlist before any fetch (no SSRF)', async () => {
    const fetchImpl = stubbedFetch(imageResponse(await pngBuffer(10, 10)));
    const disallowed = [
      'anilist:https://evil.example/x.jpg', // host not on the allowlist
      'anilist:http://s4.anilist.co/file/x.png', // non-https scheme
      'anilist:ftp://s4.anilist.co/file/x.png', // non-https scheme
      'anilist:https://user:pass@s4.anilist.co/file/x.png', // userinfo present
      'anilist:https://s4.anilist.co:8443/file/x.png', // non-standard port
      'anilist:https://s4.anilist.co.evil.example/x.png', // suffix host confusion
      'anilist:https://evil.example/x@s4.anilist.co', // path @ trick
      'anilist:/file/anilistcdn/x.png', // not an absolute URL
      'anilist:', // empty remainder
    ];
    for (const uri of disallowed) {
      await expect(resolveArtwork(uri, 'w400', options(fetchImpl))).rejects.toMatchObject({
        code: 'INVALID_SOURCE',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled(); // rejected before building any request
  });

  it('rejects source bytes that are not a decodable image', async () => {
    const fetchImpl = stubbedFetch(imageResponse(Buffer.from('not an image'), 'image/png'));

    await expect(resolveArtwork(ANILIST_URI, 'w400', options(fetchImpl))).rejects.toMatchObject({
      code: 'NOT_AN_IMAGE',
    });
  });
});

describe('resolveArtwork local sources', () => {
  it('resizes a local image that lives inside a media root', async () => {
    const localPath = path.join(mediaRoot, 'movie', 'poster.jpg');
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, await pngBuffer(1000, 1500));

    const resolved = await resolveArtwork(localPath, 'w200', options());
    const meta = await sharp(await readFile(resolved.filePath)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(200);
  });

  it('rejects a local image outside every media root', async () => {
    const outsidePath = path.join(tempDir, 'outside.jpg');
    await writeFile(outsidePath, await pngBuffer(100, 100));

    await expect(resolveArtwork(outsidePath, 'w200', options())).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
  });

  it('rejects a relative source path that is neither tmdb: nor absolute', async () => {
    await expect(resolveArtwork('relative/poster.jpg', 'w200', options())).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
  });
});

describe('evictArtworkCache', () => {
  it('deletes least-recently-used files first until under the byte budget', async () => {
    const png = await pngBuffer(1000, 1500);
    const fetchImpl = stubbedFetch(imageResponse(png));

    const older = await resolveArtwork('tmdb:/old.jpg', 'w400', options(fetchImpl));
    const middle = await resolveArtwork('tmdb:/mid.jpg', 'w400', options(fetchImpl));
    const newer = await resolveArtwork('tmdb:/new.jpg', 'w400', options(fetchImpl));

    // Stamp deterministic recency (oldest → newest).
    const base = Date.now();
    await utimes(older.filePath, new Date(base - 30_000), new Date(base - 30_000));
    await utimes(middle.filePath, new Date(base - 20_000), new Date(base - 20_000));
    await utimes(newer.filePath, new Date(base - 10_000), new Date(base - 10_000));

    const sizes = await Promise.all(
      [older, middle, newer].map((r) => stat(r.filePath).then((s) => s.size)),
    );
    // Budget only fits the two most-recently-used files.
    const maxBytes = sizes[1]! + sizes[2]!;

    const result = await evictArtworkCache({ configDir, maxBytes });

    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBe(sizes[0]);
    expect(result.remainingBytes).toBeLessThanOrEqual(maxBytes);
    expect(existsSync(older.filePath)).toBe(false); // oldest evicted
    expect(existsSync(middle.filePath)).toBe(true);
    expect(existsSync(newer.filePath)).toBe(true);
  });

  it('is a no-op when the cache is empty or absent', async () => {
    const result = await evictArtworkCache({ configDir, maxBytes: 1000 });
    expect(result).toEqual({ deletedFiles: 0, freedBytes: 0, remainingBytes: 0 });
  });
});

describe('clearArtworkCache', () => {
  it('removes every cached file', async () => {
    const fetchImpl = stubbedFetch(imageResponse(await pngBuffer(500, 750)));
    const resolved = await resolveArtwork('tmdb:/wipe.jpg', 'w400', options(fetchImpl));
    expect(existsSync(resolved.filePath)).toBe(true);

    await clearArtworkCache(configDir);
    expect(existsSync(artworkCacheDir(configDir))).toBe(false);
  });
});

describe('ArtworkError', () => {
  it('is an Error carrying a typed code', () => {
    const err = new ArtworkError('NOT_AN_IMAGE', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('NOT_AN_IMAGE');
  });
});
