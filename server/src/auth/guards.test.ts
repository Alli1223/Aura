import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Library, PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { assertMediaItemAccess } from './access.js';
import { requireLibraryAccess } from './guards.js';

// Integration tests for the RBAC route guards. Throwaway routes are
// registered on the app purely to exercise each guard; the real media
// routes (later phases) will use the exact same composition.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface ErrorBody {
  error: { code: string; message: string };
}

interface Session {
  id: string;
  username: string;
  accessToken: string;
}

/** Registers a fresh account via the real endpoint and returns its session. */
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

function get(url: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function createLibrary(type = 'movies'): Promise<Library> {
  const suffix = randomUUID();
  return prisma.library.create({
    data: {
      name: `Library ${suffix}`,
      type,
      paths: { create: { path: `/media/${type}/${suffix}` } },
    },
  });
}

let adminSession: Session; // first registered user => admin
let userSession: Session;
let libraryA: Library; // userSession has a grant
let libraryB: Library; // no grants
let movieInA: { id: string; title: string };
let movieInB: { id: string };

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-guards-test-'));
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

  // Throwaway guarded routes, mirroring how real media routes will compose.
  app.get('/test/admin-only', { preHandler: [app.authenticate, app.requireAdmin] }, async () => ({
    ok: true,
  }));
  app.get(
    '/test/libraries/:libraryId',
    { preHandler: [app.authenticate, requireLibraryAccess()] },
    async (request) => ({ libraryId: (request.params as { libraryId: string }).libraryId }),
  );
  app.get(
    '/test/custom/:libId',
    { preHandler: [app.authenticate, requireLibraryAccess('libId')] },
    async () => ({ ok: true }),
  );
  // Deliberate wiring bug: guard expects :libraryId but the route has none.
  app.get(
    '/test/miswired',
    { preHandler: [app.authenticate, requireLibraryAccess()] },
    async () => ({ ok: true }),
  );
  app.get('/test/media/:mediaItemId', { preHandler: app.authenticate }, async (request) => {
    const { mediaItemId } = request.params as { mediaItemId: string };
    const item = await assertMediaItemAccess(request.user, mediaItemId);
    return { id: item.id, title: item.title, libraryId: item.libraryId };
  });

  await app.ready();

  adminSession = await registerUser(); // first user becomes admin
  userSession = await registerUser();

  libraryA = await createLibrary('movies');
  libraryB = await createLibrary('tv');
  await prisma.libraryAccess.create({
    data: { userId: userSession.id, libraryId: libraryA.id, grantedById: adminSession.id },
  });

  movieInA = await prisma.mediaItem.create({
    data: { libraryId: libraryA.id, type: 'movie', title: 'Granted Movie', sortTitle: 'granted' },
  });
  movieInB = await prisma.mediaItem.create({
    data: { libraryId: libraryB.id, type: 'movie', title: 'Secret Movie', sortTitle: 'secret' },
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('unauthenticated requests', () => {
  it.each([
    ['admin route', '/test/admin-only'],
    ['library route', '/test/libraries/some-id'],
    ['media route', '/test/media/some-id'],
  ])('rejects the %s with 401 UNAUTHORIZED', async (_label, url) => {
    for (const token of [undefined, 'garbage-token']) {
      const response = await get(url, token);
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('requireAdmin', () => {
  it('allows admins', async () => {
    const response = await get('/test/admin-only', adminSession.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('rejects regular users with the standard 403 FORBIDDEN shape', async () => {
    const response = await get('/test/admin-only', userSession.accessToken);

    expect(response.statusCode).toBe(403);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBeTruthy();
  });

  it('rejects admins demoted after their token was issued (role is read fresh)', async () => {
    const demoted = await registerUser();
    await prisma.user.update({ where: { id: demoted.id }, data: { role: 'admin' } });
    const promoted = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: demoted.username, password: PASSWORD },
    });
    const adminToken = promoted.json<{ accessToken: string }>().accessToken;
    expect((await get('/test/admin-only', adminToken)).statusCode).toBe(200);

    await prisma.user.update({ where: { id: demoted.id }, data: { role: 'user' } });

    expect((await get('/test/admin-only', adminToken)).statusCode).toBe(403);
  });

  it('rejects admins disabled after their token was issued', async () => {
    const disabled = await registerUser();
    await prisma.user.update({ where: { id: disabled.id }, data: { isEnabled: false } });

    const response = await get('/test/admin-only', disabled.accessToken);

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('requireLibraryAccess', () => {
  it('allows admins into any library', async () => {
    for (const id of [libraryA.id, libraryB.id]) {
      const response = await get(`/test/libraries/${id}`, adminSession.accessToken);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ libraryId: string }>().libraryId).toBe(id);
    }
  });

  it('allows users into granted libraries', async () => {
    const response = await get(`/test/libraries/${libraryA.id}`, userSession.accessToken);

    expect(response.statusCode).toBe(200);
  });

  it('rejects ungranted libraries with an identical 403 whether they exist or not', async () => {
    const existing = await get(`/test/libraries/${libraryB.id}`, userSession.accessToken);
    const missing = await get('/test/libraries/no-such-library', userSession.accessToken);

    expect(existing.statusCode).toBe(403);
    expect(existing.json<ErrorBody>().error.code).toBe('FORBIDDEN');
    expect(missing.statusCode).toBe(403);
    expect(missing.json<ErrorBody>()).toEqual(existing.json<ErrorBody>());
  });

  it('supports custom path parameter names', async () => {
    const allowed = await get(`/test/custom/${libraryA.id}`, userSession.accessToken);
    const denied = await get(`/test/custom/${libraryB.id}`, userSession.accessToken);

    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
  });

  it('fails closed with a 500 INTERNAL when the route lacks the parameter', async () => {
    const response = await get('/test/miswired', adminSession.accessToken);

    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>().error.code).toBe('INTERNAL');
  });

  it('enforces a revoked grant immediately', async () => {
    const revoked = await registerUser();
    await prisma.libraryAccess.create({
      data: { userId: revoked.id, libraryId: libraryB.id },
    });
    expect((await get(`/test/libraries/${libraryB.id}`, revoked.accessToken)).statusCode).toBe(200);

    await prisma.libraryAccess.delete({
      where: { userId_libraryId: { userId: revoked.id, libraryId: libraryB.id } },
    });

    // Same still-valid access token, next request: gone.
    const response = await get(`/test/libraries/${libraryB.id}`, revoked.accessToken);
    expect(response.statusCode).toBe(403);
  });
});

describe('assertMediaItemAccess over HTTP', () => {
  it('returns the item for users with a grant on its library', async () => {
    const response = await get(`/test/media/${movieInA.id}`, userSession.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string; title: string; libraryId: string }>()).toEqual({
      id: movieInA.id,
      title: 'Granted Movie',
      libraryId: libraryA.id,
    });
  });

  it('returns the item for admins without any grant', async () => {
    const response = await get(`/test/media/${movieInB.id}`, adminSession.accessToken);

    expect(response.statusCode).toBe(200);
  });

  it('returns 404 for a missing item', async () => {
    const response = await get('/test/media/no-such-item', adminSession.accessToken);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('returns the same 404 for an item in an ungranted library as for a missing item — existence is never leaked', async () => {
    const inUngranted = await get(`/test/media/${movieInB.id}`, userSession.accessToken);
    const missing = await get('/test/media/no-such-item', userSession.accessToken);

    expect(inUngranted.statusCode).toBe(404);
    expect(inUngranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(missing.statusCode).toBe(404);
    // Byte-identical bodies: nothing distinguishes forbidden from missing.
    expect(inUngranted.body).toBe(missing.body);
  });

  it('enforces a revoked grant immediately', async () => {
    const revoked = await registerUser();
    await prisma.libraryAccess.create({
      data: { userId: revoked.id, libraryId: libraryA.id },
    });
    expect((await get(`/test/media/${movieInA.id}`, revoked.accessToken)).statusCode).toBe(200);

    await prisma.libraryAccess.delete({
      where: { userId_libraryId: { userId: revoked.id, libraryId: libraryA.id } },
    });

    expect((await get(`/test/media/${movieInA.id}`, revoked.accessToken)).statusCode).toBe(404);
  });
});
