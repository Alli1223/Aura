import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ensureTrickplay,
  ffmpegRunner,
  generateTrickplay,
  locateThumbnail,
  readTrickplayManifest,
  resolveSpritePath,
  TrickplayUnavailableError,
  trickplayCacheRoot,
  type FfmpegRunner,
  type TrickplayFile,
  type TrickplayManifest,
} from './trickplay.js';

// Real ffmpeg exercises: a ~20s clip is turned into sprite sheets + a manifest,
// and the manifest math + path-safety helpers are asserted directly. ffmpeg is
// a hard project dependency; the suite fails loudly (not skips) if it is
// missing. Binary location is configurable via FFMPEG_PATH.

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

let tempDir: string;
let mediaRoot: string;
let cacheRoot: string;
let clipPath: string;
let clipSize: number;
let clipMtimeMs: number;

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, ['-y', '-v', 'error', ...args]);
}

function fileFor(id: string, overrides: Partial<TrickplayFile> = {}): TrickplayFile {
  return {
    id,
    path: clipPath,
    width: 640,
    height: 360,
    sizeBytes: clipSize,
    mtimeMs: clipMtimeMs,
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    await execFileAsync(FFMPEG, ['-version']);
  } catch (cause) {
    throw new Error('ffmpeg is required to run the trickplay test suite', { cause });
  }

  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-trickplay-test-'));
  mediaRoot = path.join(tempDir, 'media');
  cacheRoot = trickplayCacheRoot(path.join(tempDir, 'config'));
  await mkdir(mediaRoot, { recursive: true });

  clipPath = path.join(mediaRoot, 'clip.mp4');
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=20:size=640x360:rate=15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    clipPath,
  ]);
  const stats = await stat(clipPath);
  clipSize = stats.size;
  clipMtimeMs = Math.round(stats.mtimeMs);
}, 120_000);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('generateTrickplay', () => {
  it('produces sprite sheets + a manifest for a 20s clip at a 10s interval', async () => {
    const manifest = await generateTrickplay(fileFor('gen-basic'), {
      cacheRoot,
      mediaRoots: [mediaRoot],
      intervalSec: 10,
      thumbWidth: 320,
    });

    // 20s @ one frame / 10s => 2 thumbnails, packed into a tight single sheet.
    expect(manifest.thumbnailCount).toBe(2);
    expect(manifest.intervalSec).toBe(10);
    expect(manifest.thumbWidth).toBe(320);
    expect(manifest.thumbHeight).toBe(180); // 360 * 320/640
    expect(manifest.columns).toBe(2);
    expect(manifest.rows).toBe(1);
    expect(manifest.tilesPerSheet).toBe(2);
    expect(manifest.sheets).toEqual(['sprite-0.jpg']);

    // The sprite sheet exists on disk and is a real JPEG (SOI marker).
    const dir = path.join(cacheRoot, 'gen-basic');
    const bytes = await readFile(path.join(dir, 'sprite-0.jpg'));
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);

    // The manifest is readable back and identical.
    const reread = await readTrickplayManifest(cacheRoot, 'gen-basic');
    expect(reread).toEqual(manifest);

    // No intermediate frames leak into the published directory.
    const dirStat = await stat(path.join(dir, 'frames')).catch(() => undefined);
    expect(dirStat).toBeUndefined();
  });

  it('rejects a file whose dimensions are unknown', async () => {
    await expect(
      generateTrickplay(fileFor('gen-nodims', { width: null }), {
        cacheRoot,
        mediaRoots: [mediaRoot],
      }),
    ).rejects.toMatchObject({ reason: 'no-dimensions' });
  });

  it('rejects a source that resolves outside the media roots', async () => {
    const err = await generateTrickplay(fileFor('gen-outside'), {
      cacheRoot,
      // A root that does not contain the clip => the input is outside the roots.
      mediaRoots: [path.join(tempDir, 'other-root')],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrickplayUnavailableError);
    expect((err as TrickplayUnavailableError).reason).toBe('input-outside-roots');
  });
});

describe('ensureTrickplay idempotency', () => {
  it('generates once, then serves an unchanged file from cache without ffmpeg', async () => {
    let calls = 0;
    const counting: FfmpegRunner = async (bin, args, timeout) => {
      calls += 1;
      return ffmpegRunner(bin, args, timeout);
    };

    const first = await ensureTrickplay(fileFor('idem'), {
      cacheRoot,
      mediaRoots: [mediaRoot],
      intervalSec: 10,
      runFfmpeg: counting,
    });
    // Two passes: extract frames, then tile them.
    expect(calls).toBe(2);

    const second = await ensureTrickplay(fileFor('idem'), {
      cacheRoot,
      mediaRoots: [mediaRoot],
      intervalSec: 10,
      runFfmpeg: counting,
    });
    expect(calls).toBe(2); // no re-run: the cached manifest is fresh
    expect(second).toEqual(first);
  });

  it('regenerates when the source size/mtime changed', async () => {
    let calls = 0;
    const counting: FfmpegRunner = async (bin, args, timeout) => {
      calls += 1;
      return ffmpegRunner(bin, args, timeout);
    };
    const options = {
      cacheRoot,
      mediaRoots: [mediaRoot],
      intervalSec: 10,
      runFfmpeg: counting,
    };

    await ensureTrickplay(fileFor('idem-change'), options);
    expect(calls).toBe(2);

    // A newer mtime invalidates the freshness key.
    await ensureTrickplay(fileFor('idem-change', { mtimeMs: clipMtimeMs + 5_000 }), options);
    expect(calls).toBe(4);
  });
});

describe('locateThumbnail (manifest math)', () => {
  // A hand-built multi-sheet manifest exercises row-wrap, sheet-spill and
  // clamping deterministically, independent of ffmpeg frame timing.
  const manifest: TrickplayManifest = {
    version: 1,
    mediaFileId: 'math',
    sourceSize: 1,
    sourceMtimeMs: 1,
    intervalSec: 10,
    thumbWidth: 320,
    thumbHeight: 180,
    columns: 10,
    rows: 10,
    tilesPerSheet: 100,
    thumbnailCount: 150,
    sheets: ['sprite-0.jpg', 'sprite-1.jpg'],
  };

  it('maps the first thumbnail to the top-left of sheet 0', () => {
    expect(locateThumbnail(manifest, 0)).toEqual({
      index: 0,
      sheet: 'sprite-0.jpg',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
    });
  });

  it('wraps to the next row within a sheet', () => {
    // t=120s => index 12 => col 2, row 1.
    expect(locateThumbnail(manifest, 120)).toMatchObject({
      index: 12,
      sheet: 'sprite-0.jpg',
      x: 640,
      y: 180,
    });
  });

  it('spills onto the next sheet past tilesPerSheet', () => {
    // t=1000s => index 100 => sheet 1, col 0, row 0.
    expect(locateThumbnail(manifest, 1000)).toMatchObject({
      index: 100,
      sheet: 'sprite-1.jpg',
      x: 0,
      y: 0,
    });
  });

  it('clamps a time past the end to the last thumbnail', () => {
    expect(locateThumbnail(manifest, 999_999).index).toBe(149);
  });

  it('clamps a negative/non-finite time to the first thumbnail', () => {
    expect(locateThumbnail(manifest, -5).index).toBe(0);
    expect(locateThumbnail(manifest, Number.NaN).index).toBe(0);
  });
});

describe('resolveSpritePath (path safety)', () => {
  it('accepts a well-formed sprite filename', () => {
    const resolved = resolveSpritePath(cacheRoot, 'file1', 'sprite-0.jpg');
    expect(resolved).toBe(path.join(cacheRoot, 'file1', 'sprite-0.jpg'));
  });

  it('rejects traversal and non-sprite filenames', () => {
    expect(resolveSpritePath(cacheRoot, 'file1', '../../etc/passwd')).toBeUndefined();
    expect(resolveSpritePath(cacheRoot, 'file1', 'sprite-0.jpg.bak')).toBeUndefined();
    expect(resolveSpritePath(cacheRoot, 'file1', 'manifest.json')).toBeUndefined();
    expect(resolveSpritePath(cacheRoot, 'file1', 'sprite-0.png')).toBeUndefined();
  });

  it('rejects a media file id that is not a bare token', () => {
    expect(resolveSpritePath(cacheRoot, '../escape', 'sprite-0.jpg')).toBeUndefined();
    expect(resolveSpritePath(cacheRoot, 'a/b', 'sprite-0.jpg')).toBeUndefined();
  });
});
