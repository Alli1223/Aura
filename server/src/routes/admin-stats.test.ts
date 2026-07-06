import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for the admin server-wide stats endpoint. Seeds a known
// fixture (users, libraries, items, files, watch states) and asserts the
// aggregates: per-library storage sums, item/file/user counts, most-watched
// ordering, most-active users and admin-only access.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface Session {
  id: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface AdminStats {
  totals: {
    users: number;
    libraries: number;
    files: number;
    items: { movie: number; show: number; season: number; episode: number; total: number };
  };
  storageByLibrary: Array<{
    libraryId: string;
    name: string;
    type: string;
    fileCount: number;
    totalBytes: number;
  }>;
  mostWatched: Array<{
    mediaItemId: string;
    title: string;
    type: string;
    showTitle: string | null;
    playCount: number;
    viewers: number;
  }>;
  mostActiveUsers: Array<{
    userId: string;
    username: string;
    playCount: number;
    itemCount: number;
  }>;
  recentlyAdded: { last24h: number; last7d: number; last30d: number };
}

let admin: Session;
let user: Session;

function auth(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

function getStats(token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/api/admin/stats', headers: auth(token) });
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
  return { id: body.user.id, accessToken: body.accessToken };
}

let fileCounter = 0;
function createFile(mediaItemId: string, size: number) {
  fileCounter += 1;
  return prisma.mediaFile.create({
    data: {
      mediaItemId,
      path: `/media/file-${fileCounter}-${randomUUID().slice(0, 8)}.mkv`,
      size: BigInt(size),
      mtimeMs: BigInt(1_700_000_000_000),
    },
  });
}

interface Fixture {
  moviesLibraryId: string;
  tvLibraryId: string;
  movie1: string;
  movie2: string;
  showId: string;
  episode1: string;
}

/**
 * Seeds two libraries with items + files:
 *   Movies: movie1 (100 B), movie2 (200 B)                → 300 B, 2 files
 *   TV:     show → season → episode1 (1000 B), episode2 (3000 B) → 4000 B, 2 files
 */
async function seedFixture(): Promise<Fixture> {
  const movies = await prisma.library.create({ data: { name: 'Movies', type: 'movies' } });
  const tv = await prisma.library.create({ data: { name: 'TV', type: 'tv' } });

  const movie1 = await prisma.mediaItem.create({
    data: { libraryId: movies.id, type: 'movie', title: 'Alpha', sortTitle: 'alpha' },
  });
  const movie2 = await prisma.mediaItem.create({
    data: { libraryId: movies.id, type: 'movie', title: 'Beta', sortTitle: 'beta' },
  });
  await createFile(movie1.id, 100);
  await createFile(movie2.id, 200);

  const show = await prisma.mediaItem.create({
    data: { libraryId: tv.id, type: 'show', title: 'Gamma Show', sortTitle: 'gamma show' },
  });
  const season = await prisma.mediaItem.create({
    data: {
      libraryId: tv.id,
      type: 'season',
      parentId: show.id,
      title: 'Season 1',
      sortTitle: 'season 1',
      seasonNumber: 1,
    },
  });
  const episode1 = await prisma.mediaItem.create({
    data: {
      libraryId: tv.id,
      type: 'episode',
      parentId: season.id,
      title: 'Ep One',
      sortTitle: 'ep one',
      seasonNumber: 1,
      episodeNumber: 1,
    },
  });
  const episode2 = await prisma.mediaItem.create({
    data: {
      libraryId: tv.id,
      type: 'episode',
      parentId: season.id,
      title: 'Ep Two',
      sortTitle: 'ep two',
      seasonNumber: 1,
      episodeNumber: 2,
    },
  });
  await createFile(episode1.id, 1000);
  await createFile(episode2.id, 3000);

  return {
    moviesLibraryId: movies.id,
    tvLibraryId: tv.id,
    movie1: movie1.id,
    movie2: movie2.id,
    showId: show.id,
    episode1: episode1.id,
  };
}

function seedWatch(
  userId: string,
  mediaItemId: string,
  playCount: number,
  watched = playCount > 0,
) {
  return prisma.watchState.create({
    data: { userId, mediaItemId, playCount, watched, positionMs: watched ? 0 : 5_000 },
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-admin-stats-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  admin = await registerUser(); // first registered user becomes admin
  user = await registerUser();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.watchState.deleteMany();
  await prisma.mediaFile.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.libraryAccess.deleteMany();
  await prisma.library.deleteMany();
});

describe('GET /api/admin/stats access control', () => {
  it('rejects unauthenticated (401) and non-admin (403) callers', async () => {
    expect((await getStats()).statusCode).toBe(401);
    const forbidden = await getStats(user.accessToken);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/admin/stats aggregates', () => {
  it('returns correct totals and per-library storage', async () => {
    await seedFixture();

    const response = await getStats(admin.accessToken);
    expect(response.statusCode).toBe(200);
    const stats = response.json<AdminStats>();

    expect(stats.totals.users).toBe(2);
    expect(stats.totals.libraries).toBe(2);
    expect(stats.totals.files).toBe(4);
    expect(stats.totals.items).toEqual({ movie: 2, show: 1, season: 1, episode: 2, total: 6 });

    // Sorted largest-first: TV (4000) then Movies (300).
    expect(stats.storageByLibrary.map((row) => [row.name, row.totalBytes, row.fileCount])).toEqual([
      ['TV', 4000, 2],
      ['Movies', 300, 2],
    ]);
  });

  it('ranks most-watched items by aggregate play count with show context', async () => {
    const fixture = await seedFixture();
    // movie1: two viewers, total playCount 7 (5 + 2)
    await seedWatch(user.id, fixture.movie1, 5);
    await seedWatch(admin.id, fixture.movie1, 2);
    // episode1: one viewer, playCount 3
    await seedWatch(user.id, fixture.episode1, 3);
    // movie2: in-progress only (playCount 0) — excluded from most-watched
    await seedWatch(user.id, fixture.movie2, 0, false);

    const stats = (await getStats(admin.accessToken)).json<AdminStats>();

    expect(stats.mostWatched.map((row) => row.mediaItemId)).toEqual([
      fixture.movie1,
      fixture.episode1,
    ]);
    expect(stats.mostWatched[0]).toMatchObject({ playCount: 7, viewers: 2, title: 'Alpha' });
    expect(stats.mostWatched[1]).toMatchObject({
      playCount: 3,
      type: 'episode',
      showTitle: 'Gamma Show',
    });
  });

  it('ranks most-active users by aggregate play count', async () => {
    const fixture = await seedFixture();
    await seedWatch(user.id, fixture.movie1, 5);
    await seedWatch(user.id, fixture.episode1, 3);
    await seedWatch(admin.id, fixture.movie1, 2);

    const stats = (await getStats(admin.accessToken)).json<AdminStats>();

    expect(stats.mostActiveUsers.map((row) => [row.userId, row.playCount])).toEqual([
      [user.id, 8],
      [admin.id, 2],
    ]);
    expect(stats.mostActiveUsers[0]?.itemCount).toBe(2);
  });

  it('counts recently-added top-level items', async () => {
    await seedFixture();
    const stats = (await getStats(admin.accessToken)).json<AdminStats>();
    // 2 movies + 1 show are top-level and freshly added; seasons/episodes are not.
    expect(stats.recentlyAdded.last7d).toBe(3);
    expect(stats.recentlyAdded.last24h).toBe(3);
  });
});
