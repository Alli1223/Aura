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

// Integration tests for the collections API against a real temporary SQLite DB.
// Libraries + movies + grants are built through prisma; requests go through the
// real app so auth, admin guards, the visibility rule, the parental filter and
// the 404 cloak are all exercised end to end. The first-registered user is the
// admin (sees everything). userA is granted only the movie library; userB has
// no grants; restricted is granted the movie library but capped at PG-13.

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
interface SerializedCollection {
  id: string;
  name: string;
  sortName: string;
  overview: string | null;
  source: string;
  tmdbCollectionId: number | null;
  itemCount: number;
  posterUrl: string | null;
}
interface SerializedItem {
  id: string;
  posterUrl: string | null;
}
interface DetailBody {
  collection: SerializedCollection;
  items: SerializedItem[];
}

let admin: Session; // first registered user (sees all)
let userA: Session; // granted the movie library only
let userB: Session; // no grants
let restricted: Session; // granted the movie library, capped at PG-13

let movieLibId: string;
let otherLibId: string; // granted to nobody
let alpha: string; // movieLib, PG-13, has poster
let bravo: string; // movieLib, PG, no poster
let rMovie: string; // movieLib, R (over the PG-13 cap), has poster
let gamma: string; // otherLib, PG, has poster (inaccessible to non-admins)

function auth(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}
function get(url: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: auth(token) });
}
type Payload = Record<string, unknown>;
function post(url: string, token: string | undefined, payload: Payload): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url, headers: auth(token), payload });
}
function patch(url: string, token: string | undefined, payload: Payload): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'PATCH', url, headers: auth(token), payload });
}
function put(url: string, token: string | undefined, payload: Payload): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'PUT', url, headers: auth(token), payload });
}
function del(url: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'DELETE', url, headers: auth(token) });
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

function createMovie(
  libraryId: string,
  title: string,
  contentRating: string | null,
  posterPath: string | null,
): Promise<{ id: string }> {
  return prisma.mediaItem.create({
    data: {
      libraryId,
      type: 'movie',
      title,
      sortTitle: title.toLowerCase(),
      contentRating,
      posterPath,
    },
    select: { id: true },
  });
}

/** Creates a collection with the given members in order; returns its id. */
async function createCollection(
  name: string,
  memberIds: string[],
  extra: { source?: string; tmdbCollectionId?: number; posterPath?: string } = {},
): Promise<string> {
  const collection = await prisma.collection.create({
    data: {
      name,
      sortName: name.toLowerCase(),
      source: extra.source ?? 'manual',
      tmdbCollectionId: extra.tmdbCollectionId ?? null,
      posterPath: extra.posterPath ?? null,
      items: {
        create: memberIds.map((mediaItemId, order) => ({ mediaItemId, order })),
      },
    },
  });
  return collection.id;
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-collections-test-'));
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

  admin = await registerUser(); // first user -> admin
  userA = await registerUser();
  userB = await registerUser();
  restricted = await registerUser();

  const movieLib = await prisma.library.create({ data: { name: 'Movies', type: 'movies' } });
  const otherLib = await prisma.library.create({ data: { name: 'Other', type: 'movies' } });
  movieLibId = movieLib.id;
  otherLibId = otherLib.id;

  await prisma.libraryAccess.createMany({
    data: [
      { userId: userA.id, libraryId: movieLibId },
      { userId: restricted.id, libraryId: movieLibId },
    ],
  });
  await prisma.user.update({ where: { id: restricted.id }, data: { maxContentRating: 'PG-13' } });

  alpha = (await createMovie(movieLibId, 'Alpha', 'PG-13', 'tmdb:/alpha.jpg')).id;
  bravo = (await createMovie(movieLibId, 'Bravo', 'PG', null)).id;
  rMovie = (await createMovie(movieLibId, 'Restricted', 'R', 'tmdb:/r.jpg')).id;
  gamma = (await createMovie(otherLibId, 'Gamma', 'PG', 'tmdb:/gamma.jpg')).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.collection.deleteMany();
});

describe('authentication & authorization', () => {
  it('rejects every route without a token (401 UNAUTHORIZED)', async () => {
    const id = await createCollection('X', [alpha]);
    const responses = await Promise.all([
      get('/api/collections'),
      get(`/api/collections/${id}`),
      get(`/api/collections/${id}/poster`),
      post('/api/collections', undefined, { name: 'Y' }),
      patch(`/api/collections/${id}`, undefined, { name: 'Z' }),
      del(`/api/collections/${id}`),
      post(`/api/collections/${id}/items`, undefined, { mediaItemId: bravo }),
      del(`/api/collections/${id}/items/${bravo}`),
      put(`/api/collections/${id}/items`, undefined, { orderedItemIds: [alpha] }),
    ]);
    for (const res of responses) {
      expect(res.statusCode).toBe(401);
      expect(res.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects write routes for a non-admin (403 FORBIDDEN)', async () => {
    const id = await createCollection('X', [alpha]);
    const responses = await Promise.all([
      post('/api/collections', userA.accessToken, { name: 'Y' }),
      patch(`/api/collections/${id}`, userA.accessToken, { name: 'Z' }),
      del(`/api/collections/${id}`, userA.accessToken),
      post(`/api/collections/${id}/items`, userA.accessToken, { mediaItemId: bravo }),
      del(`/api/collections/${id}/items/${bravo}`, userA.accessToken),
      put(`/api/collections/${id}/items`, userA.accessToken, { orderedItemIds: [alpha] }),
    ]);
    for (const res of responses) {
      expect(res.statusCode).toBe(403);
      expect(res.json<ErrorBody>().error.code).toBe('FORBIDDEN');
    }
  });
});

describe('admin CRUD', () => {
  it('creates, updates and deletes a collection (with audit)', async () => {
    const create = await post('/api/collections', admin.accessToken, {
      name: 'The Trilogy',
      overview: 'Three films.',
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{ collection: SerializedCollection }>().collection;
    expect(created).toMatchObject({
      name: 'The Trilogy',
      sortName: 'Trilogy, The', // article moved to the end
      overview: 'Three films.',
      source: 'manual',
      tmdbCollectionId: null,
      itemCount: 0,
      posterUrl: null,
    });

    const update = await patch(`/api/collections/${created.id}`, admin.accessToken, {
      name: 'Renamed',
      overview: null,
    });
    expect(update.statusCode).toBe(200);
    const updated = update.json<{ collection: SerializedCollection }>().collection;
    expect(updated).toMatchObject({ name: 'Renamed', sortName: 'Renamed', overview: null });

    const remove = await del(`/api/collections/${created.id}`, admin.accessToken);
    expect(remove.statusCode).toBe(204);
    expect((await get(`/api/collections/${created.id}`, admin.accessToken)).statusCode).toBe(404);

    const actions = await prisma.auditLog.findMany({
      where: { targetType: 'collection', targetId: created.id },
      select: { action: true },
    });
    const names = actions.map((entry) => entry.action);
    expect(names).toEqual(
      expect.arrayContaining(['collection.created', 'collection.updated', 'collection.deleted']),
    );
  });

  it('rejects an empty create body and an unknown-id update/delete (404)', async () => {
    expect((await post('/api/collections', admin.accessToken, {})).statusCode).toBe(400);
    expect((await patch('/api/collections/nope', admin.accessToken, { name: 'x' })).statusCode).toBe(404);
    expect((await del('/api/collections/nope', admin.accessToken)).statusCode).toBe(404);
  });
});

describe('membership', () => {
  it('adds (idempotently), reorders and removes members', async () => {
    const create = await post('/api/collections', admin.accessToken, { name: 'Set' });
    const id = create.json<{ collection: SerializedCollection }>().collection.id;

    const add1 = await post(`/api/collections/${id}/items`, admin.accessToken, { mediaItemId: alpha });
    expect(add1.statusCode).toBe(201);
    expect(add1.json<{ collection: SerializedCollection }>().collection.itemCount).toBe(1);

    // Same item again: idempotent, 200, still one member.
    const addDup = await post(`/api/collections/${id}/items`, admin.accessToken, { mediaItemId: alpha });
    expect(addDup.statusCode).toBe(200);
    expect(addDup.json<{ collection: SerializedCollection }>().collection.itemCount).toBe(1);

    const add2 = await post(`/api/collections/${id}/items`, admin.accessToken, { mediaItemId: bravo });
    expect(add2.statusCode).toBe(201);
    expect(add2.json<{ collection: SerializedCollection }>().collection.itemCount).toBe(2);

    // Default order is insertion order: alpha, then bravo.
    const before = await get(`/api/collections/${id}`, admin.accessToken);
    expect(before.json<DetailBody>().items.map((item) => item.id)).toEqual([alpha, bravo]);

    // Reorder to bravo, alpha.
    const reorder = await put(`/api/collections/${id}/items`, admin.accessToken, {
      orderedItemIds: [bravo, alpha],
    });
    expect(reorder.statusCode).toBe(200);
    expect(reorder.json<DetailBody>().items.map((item) => item.id)).toEqual([bravo, alpha]);

    // A reorder that is not exactly the member set is rejected.
    const bad = await put(`/api/collections/${id}/items`, admin.accessToken, {
      orderedItemIds: [alpha],
    });
    expect(bad.statusCode).toBe(400);

    // Remove alpha -> one member left.
    const remove = await del(`/api/collections/${id}/items/${alpha}`, admin.accessToken);
    expect(remove.statusCode).toBe(204);
    const after = await get(`/api/collections/${id}`, admin.accessToken);
    expect(after.json<DetailBody>().items.map((item) => item.id)).toEqual([bravo]);
  });

  it('404s adding to an unknown collection or an unknown media item', async () => {
    const id = await createCollection('Set', [alpha]);
    expect(
      (await post('/api/collections/nope/items', admin.accessToken, { mediaItemId: alpha })).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/collections/${id}/items`, admin.accessToken, { mediaItemId: 'ghost' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('visibility & the 404 cloak', () => {
  it('lists a collection only to callers who can access ≥1 member', async () => {
    const trilogy = await createCollection('Trilogy', [alpha, gamma]);

    // Admin sees it with both members counted.
    const adminList = (await get('/api/collections', admin.accessToken)).json<{
      collections: SerializedCollection[];
    }>().collections;
    expect(adminList.find((entry) => entry.id === trilogy)?.itemCount).toBe(2);

    // userA is granted only the movie library -> sees it, but only alpha counts.
    const aList = (await get('/api/collections', userA.accessToken)).json<{
      collections: SerializedCollection[];
    }>().collections;
    expect(aList.find((entry) => entry.id === trilogy)?.itemCount).toBe(1);

    // userB has no grants -> the collection is invisible.
    const bList = (await get('/api/collections', userB.accessToken)).json<{
      collections: SerializedCollection[];
    }>().collections;
    expect(bList.find((entry) => entry.id === trilogy)).toBeUndefined();
  });

  it('filters detail items to the accessible ones and never leaks fs paths', async () => {
    const trilogy = await createCollection('Trilogy', [alpha, gamma]);
    const res = await get(`/api/collections/${trilogy}`, userA.accessToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<DetailBody>();
    expect(body.collection.itemCount).toBe(1);
    expect(body.items.map((item) => item.id)).toEqual([alpha]);
    // Poster is the app's artwork route, not a raw tmdb:/fs path.
    expect(body.items[0]?.posterUrl).toBe(`/api/items/${alpha}/artwork/poster`);
    expect(res.body).not.toContain('tmdb:');
    expect(res.body).not.toContain('/media/');
  });

  it('cloaks an unknown id and a collection with no accessible members (404)', async () => {
    const onlyOther = await createCollection('OnlyOther', [gamma]);
    // Unknown id.
    expect((await get('/api/collections/nope', userA.accessToken)).statusCode).toBe(404);
    // Exists, but userA can access none of its members -> same 404 (invisible).
    const invisible = await get(`/api/collections/${onlyOther}`, userA.accessToken);
    expect(invisible.statusCode).toBe(404);
    expect(invisible.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    // And it never appears in userA's list.
    const list = (await get('/api/collections', userA.accessToken)).json<{
      collections: SerializedCollection[];
    }>().collections;
    expect(list.find((entry) => entry.id === onlyOther)).toBeUndefined();
  });
});

describe('parental filter', () => {
  it('hides a collection whose only accessible member is over the cap', async () => {
    const adult = await createCollection('Adult', [rMovie]);
    // restricted (PG-13 cap) cannot see the R-only collection.
    expect((await get(`/api/collections/${adult}`, restricted.accessToken)).statusCode).toBe(404);
    const list = (await get('/api/collections', restricted.accessToken)).json<{
      collections: SerializedCollection[];
    }>().collections;
    expect(list.find((entry) => entry.id === adult)).toBeUndefined();
    // The admin (exempt) still sees it.
    expect((await get(`/api/collections/${adult}`, admin.accessToken)).statusCode).toBe(200);
  });

  it('drops over-cap members from a mixed collection', async () => {
    const mixed = await createCollection('Mixed', [alpha, rMovie]);
    const res = await get(`/api/collections/${mixed}`, restricted.accessToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<DetailBody>();
    expect(body.collection.itemCount).toBe(1);
    expect(body.items.map((item) => item.id)).toEqual([alpha]);
  });
});

describe('poster', () => {
  it('serializes the poster route from the collection art, else the first member', async () => {
    // Own art -> the collection poster route.
    const own = await createCollection('Franchise', [alpha], {
      source: 'tmdb',
      tmdbCollectionId: 9999,
      posterPath: 'tmdb:/franchise.jpg',
    });
    // No own art -> the first accessible member's poster route.
    const fallback = await createCollection('Plain', [bravo, alpha]);

    const list = (await get('/api/collections', userA.accessToken)).json<{
      collections: SerializedCollection[];
    }>().collections;
    expect(list.find((entry) => entry.id === own)?.posterUrl).toBe(`/api/collections/${own}/poster`);
    // bravo has no poster, so it falls through to alpha's.
    expect(list.find((entry) => entry.id === fallback)?.posterUrl).toBe(
      `/api/items/${alpha}/artwork/poster`,
    );
  });

  it('404-cloaks the poster route for an unknown or invisible collection', async () => {
    const onlyOther = await createCollection('OnlyOther', [gamma], {
      posterPath: 'tmdb:/x.jpg',
    });
    expect((await get('/api/collections/nope/poster', userA.accessToken)).statusCode).toBe(404);
    // userA can access no member -> invisible -> cloaked before any artwork work.
    expect((await get(`/api/collections/${onlyOther}/poster`, userA.accessToken)).statusCode).toBe(404);
  });
});
