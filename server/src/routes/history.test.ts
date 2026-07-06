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

// Integration tests for the watch-history routes against a real temporary SQLite
// database. History is derived from WatchState (no event log), so tests seed
// state via the real progress/watched routes (or prisma for ungranted rows) and
// assert the derived, access-scoped, paginated history.

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
interface HistoryEntry {
  item: {
    id: string;
    type: string;
    title: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
  };
  watchState: { positionMs: number; watched: boolean; playCount: number; lastActivity: string };
  showId: string | null;
  showTitle: string | null;
}
interface HistoryBody {
  items: HistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
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

/** A tv library with one show, one season and one episode. */
async function createEpisode(): Promise<{
  libraryId: string;
  showId: string;
  episodeId: string;
}> {
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'tv' },
  });
  const show = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'show', title: 'My Show', sortTitle: 'my show' },
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
  const episode = await prisma.mediaItem.create({
    data: {
      libraryId: library.id,
      type: 'episode',
      parentId: season.id,
      title: 'Pilot',
      sortTitle: 'pilot',
      seasonNumber: 1,
      episodeNumber: 3,
    },
  });
  return { libraryId: library.id, showId: show.id, episodeId: episode.id };
}

function grant(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

function postProgress(
  itemId: string,
  payload: Record<string, unknown>,
  token: string,
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
  watched: boolean,
  token: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PUT',
    url: `/api/items/${itemId}/watched`,
    headers: auth(token),
    payload: { watched },
  });
}

function getHistory(query: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/history${query}`, headers: auth(token) });
}

function deleteHistory(itemId: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'DELETE',
    url: `/api/history/${itemId}`,
    headers: auth(token),
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-history-test-'));
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

  // Consume the first-run admin slot so every user registered in a test is an
  // ordinary, ungranted user (an admin would bypass the access checks).
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
  it('rejects the history routes without a token (401 UNAUTHORIZED)', async () => {
    const { itemId } = await createMovie();
    const responses = await Promise.all([getHistory(''), deleteHistory(itemId)]);
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('GET /api/history', () => {
  it("lists only the caller's interacted items from permitted libraries, most-recent first", async () => {
    const user = await registerUser();
    const inProgress = await createMovie(100_000);
    const watched = await createMovie(100_000);
    const ungranted = await createMovie(100_000);
    await grant(user.id, inProgress.libraryId);
    await grant(user.id, watched.libraryId);

    // Interact with the two permitted items; the second is more recent.
    await postProgress(inProgress.itemId, { positionMs: 5_000 }, user.accessToken);
    await sleep(5);
    await putWatched(watched.itemId, true, user.accessToken);

    // Ungranted library: seed a watch state directly (no grant to surface it).
    await prisma.watchState.create({
      data: { userId: user.id, mediaItemId: ungranted.itemId, positionMs: 5_000 },
    });

    const response = await getHistory('', user.accessToken);
    expect(response.statusCode).toBe(200);
    const body = response.json<HistoryBody>();
    const ids = body.items.map((entry) => entry.item.id);

    expect(ids).toEqual([watched.itemId, inProgress.itemId]); // recency desc
    expect(ids).not.toContain(ungranted.itemId);
    expect(body.total).toBe(2);

    const watchedEntry = body.items[0]!;
    expect(watchedEntry.watchState.watched).toBe(true);
    expect(watchedEntry.watchState.playCount).toBe(1);
    const progressEntry = body.items[1]!;
    expect(progressEntry.watchState.positionMs).toBe(5_000);
    expect(progressEntry.watchState.watched).toBe(false);
  });

  it("excludes another user's watch states", async () => {
    const user = await registerUser();
    const other = await registerUser();
    const movie = await createMovie(100_000);
    await grant(user.id, movie.libraryId);
    await grant(other.id, movie.libraryId);

    await postProgress(movie.itemId, { positionMs: 5_000 }, other.accessToken);

    const response = await getHistory('', user.accessToken);
    expect(response.json<HistoryBody>().total).toBe(0);
  });

  it('paginates by limit + page', async () => {
    const user = await registerUser();
    const items: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const movie = await createMovie(100_000);
      await grant(user.id, movie.libraryId);
      await postProgress(movie.itemId, { positionMs: 1_000 }, user.accessToken);
      await sleep(5);
      items.push(movie.itemId);
    }
    // Most-recent first: reverse of insertion order.
    const expected = [...items].reverse();

    const first = await getHistory('?limit=2&page=1', user.accessToken);
    const firstBody = first.json<HistoryBody>();
    expect(firstBody.total).toBe(3);
    expect(firstBody.pageSize).toBe(2);
    expect(firstBody.items.map((entry) => entry.item.id)).toEqual(expected.slice(0, 2));

    const second = await getHistory('?limit=2&page=2', user.accessToken);
    const secondBody = second.json<HistoryBody>();
    expect(secondBody.items.map((entry) => entry.item.id)).toEqual(expected.slice(2));
  });

  it('includes show context for episodes', async () => {
    const user = await registerUser();
    const { libraryId, showId, episodeId } = await createEpisode();
    await grant(user.id, libraryId);

    await putWatched(episodeId, true, user.accessToken);

    const response = await getHistory('', user.accessToken);
    const body = response.json<HistoryBody>();
    expect(body.items).toHaveLength(1);
    const entry = body.items[0]!;
    expect(entry.item.type).toBe('episode');
    expect(entry.showId).toBe(showId);
    expect(entry.showTitle).toBe('My Show');
    expect(entry.item.seasonNumber).toBe(1);
    expect(entry.item.episodeNumber).toBe(3);
  });

  it('rejects an invalid limit with 400 VALIDATION', async () => {
    const user = await registerUser();
    const response = await getHistory('?limit=0', user.accessToken);
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('DELETE /api/history/:itemId', () => {
  it("clears the caller's watch state and returns 204", async () => {
    const user = await registerUser();
    const movie = await createMovie(100_000);
    await grant(user.id, movie.libraryId);
    await postProgress(movie.itemId, { positionMs: 5_000 }, user.accessToken);

    const response = await deleteHistory(movie.itemId, user.accessToken);
    expect(response.statusCode).toBe(204);

    expect(
      await prisma.watchState.count({ where: { userId: user.id, mediaItemId: movie.itemId } }),
    ).toBe(0);
    expect((await getHistory('', user.accessToken)).json<HistoryBody>().total).toBe(0);
  });

  it('is idempotent — 204 even with no stored state', async () => {
    const user = await registerUser();
    const movie = await createMovie(100_000);
    await grant(user.id, movie.libraryId);

    const response = await deleteHistory(movie.itemId, user.accessToken);
    expect(response.statusCode).toBe(204);
  });

  it('returns a byte-identical 404 for ungranted and missing items, leaking no write', async () => {
    const user = await registerUser();
    const ungranted = await createMovie(100_000);
    // A watch state owned by nobody-in-particular on the ungranted item.
    const other = await registerUser();
    await grant(other.id, ungranted.libraryId);
    await prisma.watchState.create({
      data: { userId: other.id, mediaItemId: ungranted.itemId, positionMs: 5_000 },
    });

    const ungrantedRes = await deleteHistory(ungranted.itemId, user.accessToken);
    const missingRes = await deleteHistory('no-such-id', user.accessToken);

    expect(ungrantedRes.statusCode).toBe(404);
    expect(missingRes.statusCode).toBe(404);
    expect(ungrantedRes.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(ungrantedRes.body).toBe(missingRes.body);

    // No write leaked: the other user's state on the ungranted item survives.
    expect(await prisma.watchState.count({ where: { mediaItemId: ungranted.itemId } })).toBe(1);
  });
});
