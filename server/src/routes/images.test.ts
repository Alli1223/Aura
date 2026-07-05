import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { clearArtworkCache } from '../metadata/artwork-cache.js';

// Integration tests for GET /api/items/:id/artwork/:kind against a real
// temporary SQLite database and CONFIG_DIR. Media rows (with tmdb: artwork
// URIs) are seeded straight through prisma; users and grants flow through the
// real API. The global fetch is stubbed with a genuine PNG built by sharp, so
// the cache/resize path runs for real without touching the network.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let configDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let admin: Session;
let png: Buffer;
let fetchMock: ReturnType<typeof vi.fn>;

interface Session {
  id: string;
  username: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

function getArtwork(
  itemId: string,
  kind: string,
  opts: { size?: string; accessToken?: string; ifNoneMatch?: string } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  if (opts.accessToken !== undefined) headers.authorization = `Bearer ${opts.accessToken}`;
  if (opts.ifNoneMatch !== undefined) headers['if-none-match'] = opts.ifNoneMatch;
  const query = opts.size === undefined ? '' : `?size=${opts.size}`;
  return app.inject({
    method: 'GET',
    url: `/api/items/${itemId}/artwork/${kind}${query}`,
    headers,
  });
}

async function registerUser(): Promise<Session> {
  const username = `user-${randomUUID().slice(0, 18)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string }; accessToken: string }>();
  return { id: body.user.id, username, accessToken: body.accessToken };
}

/** Seeds a library + one movie item carrying the given artwork URIs. */
async function createItem(
  artwork: { posterPath?: string | null; backdropPath?: string | null } = {},
): Promise<{ libraryId: string; itemId: string }> {
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  // An explicit `null` means "no artwork of this kind"; an absent key defaults
  // to a fresh tmdb: URI (`?? default` would wrongly collapse the null case).
  const item = await prisma.mediaItem.create({
    data: {
      libraryId: library.id,
      type: 'movie',
      title: 'Test Movie',
      sortTitle: 'test movie',
      posterPath:
        'posterPath' in artwork ? artwork.posterPath : `tmdb:/poster-${randomUUID().slice(0, 8)}.jpg`,
      backdropPath:
        'backdropPath' in artwork
          ? artwork.backdropPath
          : `tmdb:/backdrop-${randomUUID().slice(0, 8)}.jpg`,
    },
  });
  return { libraryId: library.id, itemId: item.id };
}

function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-images-test-'));
  configDir = path.join(tempDir, 'config');
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = configDir;
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  png = await sharp({
    create: { width: 1000, height: 1500, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();

  admin = await registerUser(); // first registered user becomes admin
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearArtworkCache(configDir); // each test starts from a cold cache
  fetchMock = vi.fn(
    () =>
      Promise.resolve(
        new Response(new Uint8Array(png), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) },
        }),
      ) as Promise<Response>,
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/items/:id/artwork/:kind authentication & validation', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { itemId } = await createItem();
    const response = await getArtwork(itemId, 'poster');
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an unknown size with 400 VALIDATION', async () => {
    const { itemId } = await createItem();
    const response = await getArtwork(itemId, 'poster', { size: 'w9999', accessToken: admin.accessToken });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('rejects an unknown kind with 400 VALIDATION', async () => {
    const { itemId } = await createItem();
    const response = await getArtwork(itemId, 'banner', { accessToken: admin.accessToken });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('GET /api/items/:id/artwork/:kind delivery', () => {
  it('serves a granted user a resized webp poster with an ETag and cache headers', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createItem();
    await grantAccess(user.id, libraryId);

    const response = await getArtwork(itemId, 'poster', { size: 'w400', accessToken: user.accessToken });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['cache-control']).toBe('private, max-age=86400');
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);

    const meta = await sharp(response.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400);
  });

  it('honours If-None-Match with a 304 and no body', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createItem();
    await grantAccess(user.id, libraryId);

    const first = await getArtwork(itemId, 'poster', { size: 'w400', accessToken: user.accessToken });
    const etag = first.headers.etag as string;

    const second = await getArtwork(itemId, 'poster', {
      size: 'w400',
      accessToken: user.accessToken,
      ifNoneMatch: etag,
    });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.byteLength).toBe(0);
  });

  it('serves the second request from cache without re-fetching', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createItem();
    await grantAccess(user.id, libraryId);

    const first = await getArtwork(itemId, 'poster', { size: 'w400', accessToken: user.accessToken });
    const second = await getArtwork(itemId, 'poster', { size: 'w400', accessToken: user.accessToken });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1); // disk cache hit on the second call
  });

  it('serves a resized webp poster for an item whose posterPath is an anilist: URI', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createItem({
      posterPath: 'anilist:https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.png',
    });
    await grantAccess(user.id, libraryId);

    const response = await getArtwork(itemId, 'poster', { size: 'w400', accessToken: user.accessToken });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    const meta = await sharp(response.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets an admin fetch artwork without an explicit grant', async () => {
    const { itemId } = await createItem();
    const response = await getArtwork(itemId, 'backdrop', { accessToken: admin.accessToken });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
  });
});

describe('GET /api/items/:id/artwork/:kind enumeration cloak', () => {
  it('returns byte-identical 404s for ungranted, missing and artwork-less items', async () => {
    const user = await registerUser();

    // Ungranted: item exists in a library the user has no grant for.
    const ungrantedItem = await createItem();
    const ungranted = await getArtwork(ungrantedItem.itemId, 'poster', {
      accessToken: user.accessToken,
    });

    // Missing: no such item id at all.
    const missing = await getArtwork('no-such-item-id', 'poster', { accessToken: user.accessToken });

    // Granted item that simply has no poster.
    const noArt = await createItem({ posterPath: null });
    await grantAccess(user.id, noArt.libraryId);
    const withoutArtwork = await getArtwork(noArt.itemId, 'poster', { accessToken: user.accessToken });

    for (const response of [ungranted, missing, withoutArtwork]) {
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    }
    // Byte-identical bodies: nothing distinguishes the three cases.
    expect(ungranted.body).toBe(missing.body);
    expect(missing.body).toBe(withoutArtwork.body);
  });

  it('stops serving artwork the moment a grant is revoked', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createItem();
    await grantAccess(user.id, libraryId);
    expect((await getArtwork(itemId, 'poster', { accessToken: user.accessToken })).statusCode).toBe(
      200,
    );

    await prisma.libraryAccess.deleteMany({ where: { userId: user.id, libraryId } });

    const response = await getArtwork(itemId, 'poster', { accessToken: user.accessToken });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});
