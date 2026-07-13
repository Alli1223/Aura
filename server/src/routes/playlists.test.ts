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

// Integration tests for the playlist routes against a real temporary SQLite DB.
// Playlists are strictly per-user: every assertion here doubles as an
// access-control check (owner scoping, the 404 cloak, add access-gating and the
// read-time filtering of items the caller has lost access to).

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
interface PlaylistItem {
  id: string;
  order: number;
  hasFile: boolean;
  primaryMediaFileId: string | null;
  title: string;
}
interface PlaylistDetail {
  id: string;
  name: string;
  items: PlaylistItem[];
}
interface PlaylistSummary {
  id: string;
  name: string;
  itemCount: number;
  posterUrl: string | null;
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

async function createMovie(
  options: { poster?: boolean; withFile?: boolean; contentRating?: string } = {},
): Promise<{ libraryId: string; itemId: string; fileId: string | null }> {
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: {
      libraryId: library.id,
      type: 'movie',
      title: `Movie ${randomUUID().slice(0, 6)}`,
      sortTitle: 'movie',
      ...(options.poster === true ? { posterPath: 'tmdb:/poster.jpg' } : {}),
      ...(options.contentRating !== undefined ? { contentRating: options.contentRating } : {}),
    },
  });
  let fileId: string | null = null;
  if (options.withFile === true) {
    const file = await prisma.mediaFile.create({
      data: {
        mediaItemId: item.id,
        path: `/media/movies/${randomUUID()}.mkv`,
        size: BigInt(1_000_000),
        mtimeMs: BigInt(0),
        status: 'available',
      },
    });
    fileId = file.id;
  }
  return { libraryId: library.id, itemId: item.id, fileId };
}

function grant(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

function createPlaylist(name: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/playlists',
    headers: auth(token),
    payload: { name },
  });
}

function listPlaylists(token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/api/playlists', headers: auth(token) });
}

function getPlaylist(id: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/api/playlists/${id}`, headers: auth(token) });
}

function renamePlaylist(id: string, name: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PATCH',
    url: `/api/playlists/${id}`,
    headers: auth(token),
    payload: { name },
  });
}

function deletePlaylist(id: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'DELETE', url: `/api/playlists/${id}`, headers: auth(token) });
}

function addItem(id: string, mediaItemId: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/playlists/${id}/items`,
    headers: auth(token),
    payload: { mediaItemId },
  });
}

function removeItem(
  id: string,
  mediaItemId: string,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'DELETE',
    url: `/api/playlists/${id}/items/${mediaItemId}`,
    headers: auth(token),
  });
}

function reorder(
  id: string,
  orderedItemIds: string[],
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PUT',
    url: `/api/playlists/${id}/items`,
    headers: auth(token),
    payload: { orderedItemIds },
  });
}

/** Creates a playlist owned by `token`'s user and returns its id. */
async function makePlaylist(name: string, token: string): Promise<string> {
  const response = await createPlaylist(name, token);
  expect(response.statusCode).toBe(201);
  return response.json<{ playlist: PlaylistDetail }>().playlist.id;
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-playlists-test-'));
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
  await prisma.playlistItem.deleteMany();
  await prisma.playlist.deleteMany();
  await prisma.mediaFile.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.libraryAccess.deleteMany();
  await prisma.library.deleteMany();
});

describe('authentication', () => {
  it('rejects every playlist route without a token (401 UNAUTHORIZED)', async () => {
    const responses = await Promise.all([
      listPlaylists(),
      createPlaylist('x'),
      getPlaylist('p'),
      renamePlaylist('p', 'y'),
      deletePlaylist('p'),
      addItem('p', 'i'),
      removeItem('p', 'i'),
      reorder('p', []),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('CRUD + owner scoping', () => {
  it('creates, lists and renames the caller\'s own playlists', async () => {
    const user = await registerUser();
    const id = await makePlaylist('Road Trip', user.accessToken);

    const list = await listPlaylists(user.accessToken);
    expect(list.statusCode).toBe(200);
    const playlists = list.json<{ playlists: PlaylistSummary[] }>().playlists;
    expect(playlists).toHaveLength(1);
    expect(playlists[0]).toMatchObject({ id, name: 'Road Trip', itemCount: 0, posterUrl: null });

    const renamed = await renamePlaylist(id, 'Long Drive', user.accessToken);
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ playlist: PlaylistDetail }>().playlist.name).toBe('Long Drive');
  });

  it('deletes a playlist; a subsequent read 404s', async () => {
    const user = await registerUser();
    const id = await makePlaylist('Temp', user.accessToken);

    expect((await deletePlaylist(id, user.accessToken)).statusCode).toBe(204);
    expect((await getPlaylist(id, user.accessToken)).statusCode).toBe(404);
  });

  it('does not list another user\'s playlists', async () => {
    const owner = await registerUser();
    const other = await registerUser();
    await makePlaylist('Mine', owner.accessToken);

    const list = await listPlaylists(other.accessToken);
    expect(list.json<{ playlists: PlaylistSummary[] }>().playlists).toHaveLength(0);
  });

  it('cloaks another user\'s playlist id as a byte-identical 404 (missing vs owned)', async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const id = await makePlaylist('Private', owner.accessToken);

    const otherUserRes = await getPlaylist(id, other.accessToken);
    const missingRes = await getPlaylist('no-such-playlist', other.accessToken);

    expect(otherUserRes.statusCode).toBe(404);
    expect(missingRes.statusCode).toBe(404);
    expect(otherUserRes.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    // Indistinguishable: same status AND same body for owned-by-another vs missing.
    expect(otherUserRes.body).toBe(missingRes.body);
  });

  it('404-cloaks every mutating route for another user\'s playlist', async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const movie = await createMovie();
    await grant(other.id, movie.libraryId);
    const id = await makePlaylist('Private', owner.accessToken);

    const responses = await Promise.all([
      renamePlaylist(id, 'hacked', other.accessToken),
      deletePlaylist(id, other.accessToken),
      addItem(id, movie.itemId, other.accessToken),
      removeItem(id, movie.itemId, other.accessToken),
      reorder(id, [movie.itemId], other.accessToken),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    }
    // No write leaked: the owner's playlist is untouched.
    const owned = await getPlaylist(id, owner.accessToken);
    expect(owned.json<{ playlist: PlaylistDetail }>().playlist.name).toBe('Private');
  });

  it('rejects a blank name with 400 VALIDATION', async () => {
    const user = await registerUser();
    const response = await createPlaylist('   ', user.accessToken);
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('adding items (access-checked)', () => {
  it('adds an accessible item, exposing its play info, and is idempotent', async () => {
    const user = await registerUser();
    const movie = await createMovie({ withFile: true });
    await grant(user.id, movie.libraryId);
    const id = await makePlaylist('Watchlist', user.accessToken);

    const first = await addItem(id, movie.itemId, user.accessToken);
    expect(first.statusCode).toBe(201);
    expect(first.json<{ added: boolean }>().added).toBe(true);

    // Re-adding is a no-op (idempotent) — no duplicate, 200.
    const second = await addItem(id, movie.itemId, user.accessToken);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ added: boolean }>().added).toBe(false);

    const detail = (await getPlaylist(id, user.accessToken)).json<{ playlist: PlaylistDetail }>()
      .playlist;
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({
      id: movie.itemId,
      order: 0,
      hasFile: true,
      primaryMediaFileId: movie.fileId,
    });
  });

  it('404-cloaks adding an item the caller cannot access', async () => {
    const user = await registerUser();
    const ungranted = await createMovie();
    const id = await makePlaylist('Watchlist', user.accessToken);

    const ungrantedRes = await addItem(id, ungranted.itemId, user.accessToken);
    const missingRes = await addItem(id, 'no-such-item', user.accessToken);

    expect(ungrantedRes.statusCode).toBe(404);
    expect(missingRes.statusCode).toBe(404);
    expect(ungrantedRes.body).toBe(missingRes.body);
    // Nothing was added.
    const detail = (await getPlaylist(id, user.accessToken)).json<{ playlist: PlaylistDetail }>()
      .playlist;
    expect(detail.items).toHaveLength(0);
  });

  it('removes an item (idempotently)', async () => {
    const user = await registerUser();
    const movie = await createMovie();
    await grant(user.id, movie.libraryId);
    const id = await makePlaylist('Watchlist', user.accessToken);
    await addItem(id, movie.itemId, user.accessToken);

    expect((await removeItem(id, movie.itemId, user.accessToken)).statusCode).toBe(204);
    // Removing again still 204s.
    expect((await removeItem(id, movie.itemId, user.accessToken)).statusCode).toBe(204);

    const detail = (await getPlaylist(id, user.accessToken)).json<{ playlist: PlaylistDetail }>()
      .playlist;
    expect(detail.items).toHaveLength(0);
  });
});

describe('read-time access filtering + counts + poster', () => {
  it('omits items the caller has lost access to and reflects it in the count', async () => {
    const user = await registerUser();
    const kept = await createMovie({ poster: true });
    const lost = await createMovie();
    await grant(user.id, kept.libraryId);
    await grant(user.id, lost.libraryId);
    const id = await makePlaylist('Mix', user.accessToken);
    await addItem(id, kept.itemId, user.accessToken);
    await addItem(id, lost.itemId, user.accessToken);

    // Revoke access to the second library.
    await prisma.libraryAccess.deleteMany({ where: { userId: user.id, libraryId: lost.libraryId } });

    const detail = (await getPlaylist(id, user.accessToken)).json<{ playlist: PlaylistDetail }>()
      .playlist;
    expect(detail.items.map((entry) => entry.id)).toEqual([kept.itemId]);

    const summary = (await listPlaylists(user.accessToken)).json<{ playlists: PlaylistSummary[] }>()
      .playlists[0]!;
    // Count reflects only accessible items; poster comes from the first of them.
    expect(summary.itemCount).toBe(1);
    expect(summary.posterUrl).toBe(`/api/items/${kept.itemId}/artwork/poster`);

    // The row is still in the DB — access loss shrinks the projection, not the data.
    expect(await prisma.playlistItem.count({ where: { playlistId: id } })).toBe(2);
  });

  it('takes the listing poster from the first accessible item that has one', async () => {
    const user = await registerUser();
    const noPoster = await createMovie();
    const withPoster = await createMovie({ poster: true });
    await grant(user.id, noPoster.libraryId);
    await grant(user.id, withPoster.libraryId);
    const id = await makePlaylist('Posters', user.accessToken);
    await addItem(id, noPoster.itemId, user.accessToken);
    await addItem(id, withPoster.itemId, user.accessToken);

    const summary = (await listPlaylists(user.accessToken)).json<{ playlists: PlaylistSummary[] }>()
      .playlists[0]!;
    expect(summary.itemCount).toBe(2);
    expect(summary.posterUrl).toBe(`/api/items/${withPoster.itemId}/artwork/poster`);
  });
});

describe('reordering', () => {
  it('rewrites item order to the requested permutation', async () => {
    const user = await registerUser();
    const a = await createMovie();
    const b = await createMovie();
    const c = await createMovie();
    for (const movie of [a, b, c]) await grant(user.id, movie.libraryId);
    const id = await makePlaylist('Order', user.accessToken);
    await addItem(id, a.itemId, user.accessToken);
    await addItem(id, b.itemId, user.accessToken);
    await addItem(id, c.itemId, user.accessToken);

    const response = await reorder(id, [c.itemId, a.itemId, b.itemId], user.accessToken);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ playlist: PlaylistDetail }>().playlist.items;
    expect(items.map((entry) => entry.id)).toEqual([c.itemId, a.itemId, b.itemId]);
    expect(items.map((entry) => entry.order)).toEqual([0, 1, 2]);
  });

  it('appends omitted items after the provided ones, ignoring unknown ids', async () => {
    const user = await registerUser();
    const a = await createMovie();
    const b = await createMovie();
    for (const movie of [a, b]) await grant(user.id, movie.libraryId);
    const id = await makePlaylist('Partial', user.accessToken);
    await addItem(id, a.itemId, user.accessToken);
    await addItem(id, b.itemId, user.accessToken);

    // Only mention b (and an unknown id): b floats to front, a sinks to the end.
    const response = await reorder(id, [b.itemId, 'ghost-id'], user.accessToken);
    const items = response.json<{ playlist: PlaylistDetail }>().playlist.items;
    expect(items.map((entry) => entry.id)).toEqual([b.itemId, a.itemId]);
  });
});
