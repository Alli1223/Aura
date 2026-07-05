import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for the watch-progress routes against a real temporary
// SQLite database. Users and access grants flow through prisma directly;
// requests go through the real app so authentication, validation and the
// access cloak are all exercised end to end.

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

function auth(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
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

async function createMovie(runtimeMs?: number): Promise<{ libraryId: string; itemId: string }> {
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: {
      libraryId: library.id,
      type: 'movie',
      title: 'Movie',
      sortTitle: 'movie',
      ...(runtimeMs === undefined ? {} : { runtimeMs }),
    },
  });
  return { libraryId: library.id, itemId: item.id };
}

/** A tv library with one show, one season and `episodeCount` episodes. */
async function createShow(episodeCount: number): Promise<{
  libraryId: string;
  showId: string;
  seasonId: string;
  episodeIds: string[];
}> {
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'tv' },
  });
  const show = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'show', title: 'Show', sortTitle: 'show' },
  });
  const season = await prisma.mediaItem.create({
    data: {
      libraryId: library.id,
      type: 'season',
      parentId: show.id,
      title: 'Season 1',
      sortTitle: 'season 1',
      seasonNumber: 1,
    },
  });
  const episodeIds: string[] = [];
  for (let e = 1; e <= episodeCount; e += 1) {
    const episode = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'episode',
        parentId: season.id,
        title: `Episode ${e}`,
        sortTitle: `episode ${e}`,
        seasonNumber: 1,
        episodeNumber: e,
      },
    });
    episodeIds.push(episode.id);
  }
  return { libraryId: library.id, showId: show.id, seasonId: season.id, episodeIds };
}

function grant(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

function postProgress(
  itemId: string,
  payload: Record<string, unknown>,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/items/${itemId}/progress`,
    headers: auth(token),
    payload,
  });
}

function putWatched(
  itemId: string,
  payload: Record<string, unknown>,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PUT',
    url: `/api/items/${itemId}/watched`,
    headers: auth(token),
    payload,
  });
}

function getStateReq(itemId: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/items/${itemId}/state`, headers: auth(token) });
}

function postBatch(ids: string[], token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/items/state',
    headers: auth(token),
    payload: { ids },
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-watch-test-'));
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

  // The first registered user becomes admin (first-run). Consume that slot
  // here so every user registered inside a test is an ordinary, ungranted
  // user — otherwise an admin would bypass the access checks under test.
  await registerUser();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.watchState.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.libraryAccess.deleteMany();
  await prisma.library.deleteMany();
});

describe('authentication', () => {
  it('rejects every route without a token (401 UNAUTHORIZED)', async () => {
    const { itemId } = await createMovie();
    const responses = await Promise.all([
      postProgress(itemId, { positionMs: 1_000 }),
      putWatched(itemId, { watched: true }),
      getStateReq(itemId),
      postBatch([itemId]),
      app.inject({ method: 'GET', url: '/api/continue-watching' }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('POST /api/items/:id/progress', () => {
  it('records and resumes a position for a granted user', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createMovie();
    await grant(user.id, libraryId);

    const first = await postProgress(itemId, { positionMs: 5_000 }, user.accessToken);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ state: { positionMs: number } }>().state.positionMs).toBe(5_000);

    const second = await postProgress(itemId, { positionMs: 9_000 }, user.accessToken);
    expect(second.json<{ state: { positionMs: number } }>().state.positionMs).toBe(9_000);
  });

  it('auto-marks watched at >= 90% of the passed duration', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createMovie();
    await grant(user.id, libraryId);

    const response = await postProgress(
      itemId,
      { positionMs: 91_000, durationMs: 100_000 },
      user.accessToken,
    );
    expect(response.json<{ state: { watched: boolean } }>().state.watched).toBe(true);
  });

  it('clamps a negative position to 0', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createMovie();
    await grant(user.id, libraryId);

    const response = await postProgress(itemId, { positionMs: -1_000 }, user.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: { positionMs: number } }>().state.positionMs).toBe(0);
  });

  it('rejects a non-numeric position with 400 VALIDATION', async () => {
    const user = await registerUser();
    const { libraryId, itemId } = await createMovie();
    await grant(user.id, libraryId);

    const response = await postProgress(itemId, { positionMs: 'lots' }, user.accessToken);
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('PUT /api/items/:id/watched cascade', () => {
  it('cascades a season mark to every episode and derives show watched', async () => {
    const user = await registerUser();
    const { libraryId, showId, seasonId, episodeIds } = await createShow(3);
    await grant(user.id, libraryId);

    const response = await putWatched(seasonId, { watched: true }, user.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ summary: { affectedCount: number } }>().summary.affectedCount).toBe(3);

    const watchedCount = await prisma.watchState.count({
      where: { userId: user.id, mediaItemId: { in: episodeIds }, watched: true },
    });
    expect(watchedCount).toBe(3);

    const showState = await getStateReq(showId, user.accessToken);
    const body = showState.json<{ state: { watched: boolean; nextUnwatchedId: string | null } }>();
    expect(body.state.watched).toBe(true);
    expect(body.state.nextUnwatchedId).toBeNull();
  });

  it('surfaces the next unwatched episode and advances it as episodes are watched', async () => {
    const user = await registerUser();
    const { libraryId, showId, episodeIds } = await createShow(2);
    await grant(user.id, libraryId);

    const initial = await getStateReq(showId, user.accessToken);
    expect(initial.json<{ state: { nextUnwatchedId: string } }>().state.nextUnwatchedId).toBe(
      episodeIds[0],
    );

    await putWatched(episodeIds[0]!, { watched: true }, user.accessToken);
    const advanced = await getStateReq(showId, user.accessToken);
    expect(advanced.json<{ state: { nextUnwatchedId: string } }>().state.nextUnwatchedId).toBe(
      episodeIds[1],
    );
  });
});

describe('access enforcement (404 cloak)', () => {
  it('returns a byte-identical 404 for ungranted and missing items across all item routes', async () => {
    const user = await registerUser();
    const ungranted = await createMovie(); // exists, no grant for this user

    const cases: Array<[LightMyRequestResponse, LightMyRequestResponse]> = [
      [
        await postProgress(ungranted.itemId, { positionMs: 1_000 }, user.accessToken),
        await postProgress('no-such-id', { positionMs: 1_000 }, user.accessToken),
      ],
      [
        await putWatched(ungranted.itemId, { watched: true }, user.accessToken),
        await putWatched('no-such-id', { watched: true }, user.accessToken),
      ],
      [
        await getStateReq(ungranted.itemId, user.accessToken),
        await getStateReq('no-such-id', user.accessToken),
      ],
    ];

    for (const [ungrantedRes, missingRes] of cases) {
      expect(ungrantedRes.statusCode).toBe(404);
      expect(missingRes.statusCode).toBe(404);
      expect(ungrantedRes.json<ErrorBody>().error.code).toBe('NOT_FOUND');
      // Byte-identical: an ungranted item is indistinguishable from a missing one.
      expect(ungrantedRes.body).toBe(missingRes.body);
    }

    // No writes leaked through for the ungranted item.
    expect(await prisma.watchState.count()).toBe(0);
  });
});

describe('POST /api/items/state batch', () => {
  it('returns states for accessible ids and silently omits inaccessible ones', async () => {
    const user = await registerUser();
    const accessible = await createMovie();
    const inaccessible = await createMovie();
    await grant(user.id, accessible.libraryId);
    await postProgress(accessible.itemId, { positionMs: 7_000 }, user.accessToken);

    const response = await postBatch(
      [accessible.itemId, inaccessible.itemId, 'no-such-id'],
      user.accessToken,
    );
    expect(response.statusCode).toBe(200);
    const states = response.json<{ states: Record<string, { positionMs: number }> }>().states;
    expect(states[accessible.itemId]?.positionMs).toBe(7_000);
    expect(states[inaccessible.itemId]).toBeUndefined();
    expect(states['no-such-id']).toBeUndefined();
  });

  it('rejects an oversize batch with 400 VALIDATION', async () => {
    const user = await registerUser();
    const ids = Array.from({ length: 201 }, () => randomUUID());
    const response = await postBatch(ids, user.accessToken);
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('GET /api/continue-watching', () => {
  it('lists only in-progress accessible items, most-recent first', async () => {
    const user = await registerUser();
    const permitted = await createMovie();
    const alsoPermitted = await createMovie();
    const forbidden = await createMovie();
    await grant(user.id, permitted.libraryId);
    await grant(user.id, alsoPermitted.libraryId);

    await postProgress(permitted.itemId, { positionMs: 2_000 }, user.accessToken);
    await sleep(5); // distinct updatedAt so recency ordering is deterministic
    await postProgress(alsoPermitted.itemId, { positionMs: 2_000 }, user.accessToken);
    // Forbidden library: seed a progress row directly (no grant to report it).
    await prisma.watchState.create({
      data: { userId: user.id, mediaItemId: forbidden.itemId, positionMs: 2_000 },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/continue-watching',
      headers: auth(user.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: Array<{ mediaItemId: string }> }>().items;
    const ids = items.map((entry) => entry.mediaItemId);
    expect(ids).toContain(permitted.itemId);
    expect(ids).toContain(alsoPermitted.itemId);
    expect(ids).not.toContain(forbidden.itemId);
    // alsoPermitted was reported last -> most recent -> first.
    expect(ids[0]).toBe(alsoPermitted.itemId);
  });

  it('rejects an invalid limit with 400 VALIDATION', async () => {
    const user = await registerUser();
    const response = await app.inject({
      method: 'GET',
      url: '/api/continue-watching?limit=0',
      headers: auth(user.accessToken),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});
