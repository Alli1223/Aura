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

// Integration tests for the per-show skip-config admin API and the derived skip
// markers surfaced in the file serialization. Runs against a real temp SQLite
// DB through the full app (auth + requireAdmin + validation).

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
interface SkipMarker {
  type: 'intro' | 'credits';
  startMs: number;
  endMs: number;
}

interface Fixture {
  libId: string;
  show: string;
  season: string;
  epNoChapters: string; // file has no chapters (config synthesis path)
  epWithChapters: string; // file has an intro chapter (chapter path)
  movie: string; // no show ancestor (no config path)
}

let fx: Fixture;
let admin: Session; // first registered user => admin
let user: Session; // ordinary user

function auth(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}
function get(url: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: auth(token) });
}
function put(
  url: string,
  payload: Record<string, unknown>,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'PUT', url, headers: auth(token), payload });
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

async function seed(): Promise<Fixture> {
  const lib = await prisma.library.create({ data: { name: 'Shows', type: 'tv' } });

  const show = await prisma.mediaItem.create({
    data: { libraryId: lib.id, type: 'show', title: 'Zeta', sortTitle: 'zeta' },
  });
  const season = await prisma.mediaItem.create({
    data: {
      libraryId: lib.id,
      type: 'season',
      parentId: show.id,
      title: 'Season 1',
      sortTitle: 'season 1',
      seasonNumber: 1,
    },
  });
  const epNoChapters = await prisma.mediaItem.create({
    data: {
      libraryId: lib.id,
      type: 'episode',
      parentId: season.id,
      title: 'Zeta S1E1',
      sortTitle: 'zeta s1e1',
      seasonNumber: 1,
      episodeNumber: 1,
    },
  });
  await prisma.mediaFile.create({
    data: {
      mediaItemId: epNoChapters.id,
      path: `/media/tv/zeta-s1e1-${randomUUID().slice(0, 8)}.mkv`,
      size: 1_000_000n,
      mtimeMs: 0n,
      container: 'mkv',
      durationMs: 600_000,
    },
  });

  const epWithChapters = await prisma.mediaItem.create({
    data: {
      libraryId: lib.id,
      type: 'episode',
      parentId: season.id,
      title: 'Zeta S1E2',
      sortTitle: 'zeta s1e2',
      seasonNumber: 1,
      episodeNumber: 2,
    },
  });
  await prisma.mediaFile.create({
    data: {
      mediaItemId: epWithChapters.id,
      path: `/media/tv/zeta-s1e2-${randomUUID().slice(0, 8)}.mkv`,
      size: 1_000_000n,
      mtimeMs: 0n,
      container: 'mkv',
      durationMs: 600_000,
      chapters: {
        create: [
          { index: 0, startMs: 0, endMs: 85_000, title: 'Opening' },
          { index: 1, startMs: 85_000, endMs: 600_000, title: 'Episode' },
        ],
      },
    },
  });

  const movieLib = await prisma.library.create({ data: { name: 'Movies', type: 'movies' } });
  const movie = await prisma.mediaItem.create({
    data: { libraryId: movieLib.id, type: 'movie', title: 'Solo', sortTitle: 'solo' },
  });
  await prisma.mediaFile.create({
    data: {
      mediaItemId: movie.id,
      path: `/media/movies/solo-${randomUUID().slice(0, 8)}.mkv`,
      size: 1_000_000n,
      mtimeMs: 0n,
      container: 'mkv',
      durationMs: 600_000,
    },
  });

  return {
    libId: lib.id,
    show: show.id,
    season: season.id,
    epNoChapters: epNoChapters.id,
    epWithChapters: epWithChapters.id,
    movie: movie.id,
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-skip-config-test-'));
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

  admin = await registerUser(); // first-run => admin
  user = await registerUser(); // ordinary user
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.showSkipConfig.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.library.deleteMany();
  fx = await seed();
});

describe('PUT /api/items/:id/skip-config', () => {
  it('sets a show config, returns it, and writes an audit entry', async () => {
    const res = await put(
      `/api/items/${fx.show}/skip-config`,
      { introEndMs: 30_000, creditsFromEndMs: 60_000 },
      admin.accessToken,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<{ config: unknown }>().config).toEqual({
      introEndMs: 30_000,
      creditsStartMs: null,
      creditsFromEndMs: 60_000,
    });

    const audit = await prisma.auditLog.findFirst({ where: { action: 'skip_config.updated' } });
    expect(audit).not.toBeNull();
    expect(audit?.targetId).toBe(fx.show);
    expect(audit?.userId).toBe(admin.id);
  });

  it('merges a partial update: an omitted field is preserved, null clears', async () => {
    await put(
      `/api/items/${fx.show}/skip-config`,
      { introEndMs: 30_000, creditsStartMs: 500_000 },
      admin.accessToken,
    );
    // introEndMs omitted (preserved), creditsStartMs cleared to null.
    const res = await put(
      `/api/items/${fx.show}/skip-config`,
      { creditsStartMs: null },
      admin.accessToken,
    );
    expect(res.json<{ config: { introEndMs: number | null; creditsStartMs: number | null } }>()
      .config).toEqual({ introEndMs: 30_000, creditsStartMs: null, creditsFromEndMs: null });
  });

  it('rejects a non-show item with 400 VALIDATION', async () => {
    const res = await put(
      `/api/items/${fx.movie}/skip-config`,
      { introEndMs: 1_000 },
      admin.accessToken,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('rejects a missing item with 404 NOT_FOUND', async () => {
    const res = await put(
      '/api/items/no-such-item/skip-config',
      { introEndMs: 1_000 },
      admin.accessToken,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('rejects an empty body (nothing to set) with 400', async () => {
    const res = await put(`/api/items/${fx.show}/skip-config`, {}, admin.accessToken);
    expect(res.statusCode).toBe(400);
  });

  it('rejects setting both credits offsets at once with 400', async () => {
    const res = await put(
      `/api/items/${fx.show}/skip-config`,
      { creditsStartMs: 500_000, creditsFromEndMs: 60_000 },
      admin.accessToken,
    );
    expect(res.statusCode).toBe(400);
  });

  it('is admin-only: an ordinary user gets 403 FORBIDDEN', async () => {
    const res = await put(
      `/api/items/${fx.show}/skip-config`,
      { introEndMs: 1_000 },
      user.accessToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await put(`/api/items/${fx.show}/skip-config`, { introEndMs: 1_000 });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/items/:id/skip-config', () => {
  it('returns null before anything is set and reflects a set config', async () => {
    const before = await get(`/api/items/${fx.show}/skip-config`, admin.accessToken);
    expect(before.statusCode).toBe(200);
    expect(before.json<{ config: unknown }>().config).toBeNull();

    await put(`/api/items/${fx.show}/skip-config`, { introEndMs: 25_000 }, admin.accessToken);

    const after = await get(`/api/items/${fx.show}/skip-config`, admin.accessToken);
    expect(after.json<{ config: { introEndMs: number | null } }>().config).toMatchObject({
      introEndMs: 25_000,
    });
  });

  it('is admin-only: an ordinary user gets 403', async () => {
    const res = await get(`/api/items/${fx.show}/skip-config`, user.accessToken);
    expect(res.statusCode).toBe(403);
  });
});

describe('markers in file serialization', () => {
  function markersOf(res: LightMyRequestResponse): SkipMarker[] {
    return res.json<{ files: { markers: SkipMarker[] }[] }>().files[0]!.markers;
  }

  it('derives markers from a file chapter with no config (chapter path)', async () => {
    const res = await get(`/api/items/${fx.epWithChapters}`, admin.accessToken);
    expect(res.statusCode).toBe(200);
    expect(markersOf(res)).toEqual([{ type: 'intro', startMs: 0, endMs: 85_000 }]);
  });

  it("inherits the show's skip config on an episode with no chapters (episode -> show)", async () => {
    await put(
      `/api/items/${fx.show}/skip-config`,
      { introEndMs: 30_000, creditsFromEndMs: 60_000 },
      admin.accessToken,
    );
    const res = await get(`/api/items/${fx.epNoChapters}`, admin.accessToken);
    expect(markersOf(res)).toEqual([
      { type: 'intro', startMs: 0, endMs: 30_000 },
      { type: 'credits', startMs: 540_000, endMs: 600_000 },
    ]);
  });

  it('keeps the chapter marker and only fills the missing side from config', async () => {
    await put(
      `/api/items/${fx.show}/skip-config`,
      { introEndMs: 30_000, creditsFromEndMs: 60_000 },
      admin.accessToken,
    );
    // The episode's chapter supplies the intro [0,85000]; config adds credits.
    const res = await get(`/api/items/${fx.epWithChapters}`, admin.accessToken);
    expect(markersOf(res)).toEqual([
      { type: 'intro', startMs: 0, endMs: 85_000 },
      { type: 'credits', startMs: 540_000, endMs: 600_000 },
    ]);
  });

  it('leaves a movie with no chapters and no show ancestor without markers', async () => {
    const res = await get(`/api/items/${fx.movie}`, admin.accessToken);
    expect(markersOf(res)).toEqual([]);
  });
});
