import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for the library access grant API against a real
// temporary SQLite database. The first registered user is the admin; grants
// and audit rows are asserted both through the API and directly in the DB.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let mediaRoot: string;
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
interface MatrixUser {
  id: string;
  username: string;
  role: string;
  isEnabled: boolean;
  libraryIds: string[];
}
interface MatrixLibrary {
  id: string;
  name: string;
  type: string;
}
interface AccessListEntry {
  id: string;
  username: string;
  grantedAt: string;
  grantedBy: string | null;
}

let admin: Session; // primary admin (first registered user)

function api(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** Registers a fresh account via the real endpoint. */
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

/** Registers a fresh account and promotes it to admin via the admin API. */
async function registerAdmin(): Promise<Session> {
  const session = await registerUser();
  const response = await api('PATCH', `/api/users/${session.id}`, admin.accessToken, {
    role: 'admin',
  });
  expect(response.statusCode).toBe(200);
  return session;
}

/** Creates a library through the API and returns its id and name. */
async function createLibrary(type = 'movies'): Promise<{ id: string; name: string; type: string }> {
  const dir = path.join(mediaRoot, `dir-${randomUUID().slice(0, 8)}`);
  await mkdir(dir);
  const name = `Library ${randomUUID().slice(0, 8)}`;
  const response = await api('POST', '/api/libraries', admin.accessToken, {
    name,
    type,
    paths: [dir],
  });
  expect(response.statusCode).toBe(201);
  return { id: response.json<{ library: { id: string } }>().library.id, name, type };
}

/** The user's grant rows straight from the database. */
function grantRows(userId: string) {
  return prisma.libraryAccess.findMany({ where: { userId }, orderBy: { libraryId: 'asc' } });
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-access-test-')));
  mediaRoot = path.join(tempDir, 'media');
  await mkdir(mediaRoot);

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  process.env.MEDIA_ROOTS = mediaRoot;
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  admin = await registerUser(); // first registered user becomes admin
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('route protection', () => {
  it('rejects non-admins with 403 FORBIDDEN on every endpoint', async () => {
    const user = await registerUser();
    const library = await createLibrary();
    // A grant gives library access, not management rights.
    await prisma.libraryAccess.create({ data: { userId: user.id, libraryId: library.id } });

    const routes: Array<['GET' | 'PUT' | 'POST' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/access'],
      ['PUT', `/api/users/${user.id}/libraries`, { libraryIds: [] }],
      ['GET', `/api/libraries/${library.id}/access`],
      ['POST', `/api/libraries/${library.id}/access`, { userId: user.id }],
      ['DELETE', `/api/libraries/${library.id}/access/${user.id}`],
    ];
    for (const [method, url, payload] of routes) {
      const response = await api(method, url, user.accessToken, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
    }
  });

  it('rejects unauthenticated requests with 401 on every endpoint', async () => {
    for (const [method, url] of [
      ['GET', '/api/access'],
      ['PUT', '/api/users/some-id/libraries'],
      ['GET', '/api/libraries/some-id/access'],
      ['POST', '/api/libraries/some-id/access'],
      ['DELETE', '/api/libraries/some-id/access/some-user'],
    ] as const) {
      const response = await api(method, url);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('GET /api/access', () => {
  it('returns the full user x library matrix with exact shapes and ordering', async () => {
    const userA = await registerUser();
    const userB = await registerUser();
    const libraryA = await createLibrary('movies');
    const libraryB = await createLibrary('tv');
    await prisma.libraryAccess.createMany({
      data: [
        { userId: userA.id, libraryId: libraryA.id },
        { userId: userA.id, libraryId: libraryB.id },
        { userId: userB.id, libraryId: libraryB.id },
      ],
    });

    const response = await api('GET', '/api/access', admin.accessToken);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ users: MatrixUser[]; libraries: MatrixLibrary[] }>();
    expect(Object.keys(body).sort()).toEqual(['libraries', 'users']);

    // Exact element shapes — nothing but the matrix fields, on every entry.
    for (const user of body.users) {
      expect(Object.keys(user).sort()).toEqual([
        'id',
        'isEnabled',
        'libraryIds',
        'role',
        'username',
      ]);
    }
    for (const library of body.libraries) {
      expect(Object.keys(library).sort()).toEqual(['id', 'name', 'type']);
    }
    // passwordHash (or any other secret) must not appear anywhere in the JSON.
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain(PASSWORD);

    // Ordering: users by username, libraries by name.
    const usernames = body.users.map((user) => user.username);
    expect(usernames).toEqual([...usernames].sort());
    const libraryNames = body.libraries.map((library) => library.name);
    expect(libraryNames).toEqual([...libraryNames].sort());

    // Grants land on the right users; the admin has none (implicit access).
    expect(body.users.find((user) => user.id === userA.id)).toEqual({
      id: userA.id,
      username: userA.username,
      role: 'user',
      isEnabled: true,
      libraryIds: [libraryA.id, libraryB.id].sort(),
    });
    expect(body.users.find((user) => user.id === userB.id)?.libraryIds).toEqual([libraryB.id]);
    expect(body.users.find((user) => user.id === admin.id)).toEqual({
      id: admin.id,
      username: admin.username,
      role: 'admin',
      isEnabled: true,
      libraryIds: [],
    });
    expect(body.libraries.find((library) => library.id === libraryB.id)).toEqual({
      id: libraryB.id,
      name: libraryB.name,
      type: 'tv',
    });
  });
});

describe('PUT /api/users/:id/libraries', () => {
  it('replaces grants by diff, keeps overlap rows intact, and audits added/removed', async () => {
    const user = await registerUser();
    const [kept, removed, added] = [
      await createLibrary(),
      await createLibrary(),
      await createLibrary(),
    ];

    const first = await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [kept.id, removed.id],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ libraryIds: string[] }>().libraryIds).toEqual([kept.id, removed.id].sort());
    const keptRowBefore = (await grantRows(user.id)).find((row) => row.libraryId === kept.id);

    const second = await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [kept.id, added.id],
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ libraryIds: string[] }>().libraryIds).toEqual([kept.id, added.id].sort());

    // DB rows match the new set; every row records the acting admin.
    const rows = await grantRows(user.id);
    expect(rows.map((row) => row.libraryId).sort()).toEqual([kept.id, added.id].sort());
    for (const row of rows) expect(row.grantedById).toBe(admin.id);
    // The kept grant was not deleted and recreated — same row, same grantedAt.
    const keptRowAfter = rows.find((row) => row.libraryId === kept.id);
    expect(keptRowAfter?.id).toBe(keptRowBefore?.id);
    expect(keptRowAfter?.grantedAt).toEqual(keptRowBefore?.grantedAt);

    // The audit row records exactly the diff of the second call.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'access.bulk_set', targetId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.userId).toBe(admin.id);
    expect(audit?.targetType).toBe('user');
    expect(JSON.parse(audit!.details!)).toEqual({ added: [added.id], removed: [removed.id] });
  });

  it('revokes all grants with an empty array', async () => {
    const user = await registerUser();
    const [a, b] = [await createLibrary(), await createLibrary()];
    await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [a.id, b.id],
    });
    expect(await grantRows(user.id)).toHaveLength(2);

    const response = await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ libraryIds: string[] }>().libraryIds).toEqual([]);
    expect(await grantRows(user.id)).toHaveLength(0);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'access.bulk_set', targetId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(audit!.details!)).toEqual({ added: [], removed: [a.id, b.id].sort() });
  });

  it('rejects unknown library ids with 400 UNKNOWN_LIBRARY and writes nothing', async () => {
    const user = await registerUser();
    const existing = await createLibrary();
    const other = await createLibrary();
    await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [existing.id],
    });
    const before = await grantRows(user.id);

    const response = await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [other.id, 'no-such-library'],
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe('UNKNOWN_LIBRARY');
    expect(error.message).toContain('no-such-library');
    // No partial writes: the valid id in the same request was NOT granted.
    expect(await grantRows(user.id)).toEqual(before);
    expect(
      await prisma.auditLog.count({ where: { action: 'access.bulk_set', targetId: user.id } }),
    ).toBe(1); // only the initial seed call
  });

  it('returns 404 for an unknown user', async () => {
    const library = await createLibrary();
    const response = await api('PUT', '/api/users/no-such-user/libraries', admin.accessToken, {
      libraryIds: [library.id],
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('skips the audit row when the requested set equals the current set', async () => {
    const user = await registerUser();
    const library = await createLibrary();

    // Duplicate ids in the body collapse to one grant.
    const first = await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [library.id, library.id],
    });
    expect(first.statusCode).toBe(200);
    expect(await grantRows(user.id)).toHaveLength(1);

    const repeat = await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [library.id],
    });
    expect(repeat.statusCode).toBe(200);

    expect(
      await prisma.auditLog.count({ where: { action: 'access.bulk_set', targetId: user.id } }),
    ).toBe(1); // the no-op repeat wrote no audit row
  });

  it('rejects invalid bodies with 400 VALIDATION', async () => {
    const user = await registerUser();
    for (const payload of [{}, { libraryIds: 'not-an-array' }, { libraryIds: [''] }]) {
      const response = await api(
        'PUT',
        `/api/users/${user.id}/libraries`,
        admin.accessToken,
        payload,
      );
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
    }
  });
});

describe('POST /api/libraries/:id/access', () => {
  it('grants access once; repeats are 204 no-ops with one row and one audit entry', async () => {
    const user = await registerUser();
    const library = await createLibrary();

    const first = await api('POST', `/api/libraries/${library.id}/access`, admin.accessToken, {
      userId: user.id,
    });
    expect(first.statusCode).toBe(204);

    const repeat = await api('POST', `/api/libraries/${library.id}/access`, admin.accessToken, {
      userId: user.id,
    });
    expect(repeat.statusCode).toBe(204);

    const rows = await grantRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      libraryId: library.id,
      grantedById: admin.id,
    });
    expect(
      await prisma.auditLog.count({ where: { action: 'access.granted', targetId: user.id } }),
    ).toBe(1);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'access.granted', targetId: user.id },
    });
    expect(audit?.userId).toBe(admin.id);
    expect(JSON.parse(audit!.details!)).toEqual({ libraryId: library.id });
  });

  it('returns 404 for an unknown library and an unknown user', async () => {
    const user = await registerUser();
    const library = await createLibrary();

    const noLibrary = await api(
      'POST',
      '/api/libraries/no-such-library/access',
      admin.accessToken,
      {
        userId: user.id,
      },
    );
    expect(noLibrary.statusCode).toBe(404);
    expect(noLibrary.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    const noUser = await api('POST', `/api/libraries/${library.id}/access`, admin.accessToken, {
      userId: 'no-such-user',
    });
    expect(noUser.statusCode).toBe(404);
    expect(noUser.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(await prisma.libraryAccess.count({ where: { libraryId: library.id } })).toBe(0);
  });

  it('allows granting to admin-role users (meaningful if later demoted)', async () => {
    const otherAdmin = await registerAdmin();
    const library = await createLibrary();

    const response = await api('POST', `/api/libraries/${library.id}/access`, admin.accessToken, {
      userId: otherAdmin.id,
    });

    expect(response.statusCode).toBe(204);
    expect(
      await prisma.libraryAccess.count({
        where: { userId: otherAdmin.id, libraryId: library.id },
      }),
    ).toBe(1);
  });
});

describe('DELETE /api/libraries/:id/access/:userId', () => {
  it('revokes a grant; repeats are 204 no-ops with a single audit entry', async () => {
    const user = await registerUser();
    const library = await createLibrary();
    await api('POST', `/api/libraries/${library.id}/access`, admin.accessToken, {
      userId: user.id,
    });

    const first = await api(
      'DELETE',
      `/api/libraries/${library.id}/access/${user.id}`,
      admin.accessToken,
    );
    expect(first.statusCode).toBe(204);
    expect(await grantRows(user.id)).toHaveLength(0);

    const repeat = await api(
      'DELETE',
      `/api/libraries/${library.id}/access/${user.id}`,
      admin.accessToken,
    );
    expect(repeat.statusCode).toBe(204);

    expect(
      await prisma.auditLog.count({ where: { action: 'access.revoked', targetId: user.id } }),
    ).toBe(1);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'access.revoked', targetId: user.id },
    });
    expect(audit?.userId).toBe(admin.id);
    expect(JSON.parse(audit!.details!)).toEqual({ libraryId: library.id });
  });

  it('is a 204 no-op (without audit) for ids that never had a grant', async () => {
    const response = await api(
      'DELETE',
      '/api/libraries/no-such-library/access/no-such-user',
      admin.accessToken,
    );
    expect(response.statusCode).toBe(204);
    expect(
      await prisma.auditLog.count({
        where: { action: 'access.revoked', targetId: 'no-such-user' },
      }),
    ).toBe(0);
  });
});

describe('GET /api/libraries/:id/access', () => {
  it('lists granted users ordered by username with grantedBy resolved', async () => {
    const userA = await registerUser();
    const userB = await registerUser();
    const library = await createLibrary();
    for (const user of [userB, userA]) {
      await api('POST', `/api/libraries/${library.id}/access`, admin.accessToken, {
        userId: user.id,
      });
    }

    const response = await api('GET', `/api/libraries/${library.id}/access`, admin.accessToken);

    expect(response.statusCode).toBe(200);
    const users = response.json<{ users: AccessListEntry[] }>().users;
    expect(users.map((entry) => entry.username)).toEqual([userA.username, userB.username].sort());
    for (const entry of users) {
      expect(Object.keys(entry).sort()).toEqual(['grantedAt', 'grantedBy', 'id', 'username']);
      expect(entry.grantedBy).toBe(admin.username);
      expect(new Date(entry.grantedAt).getTime()).not.toBeNaN();
    }
    expect(users.map((entry) => entry.id).sort()).toEqual([userA.id, userB.id].sort());
  });

  it('returns grantedBy null after the granting admin is deleted (SetNull)', async () => {
    const grantingAdmin = await registerAdmin();
    const user = await registerUser();
    const library = await createLibrary();
    const grant = await api(
      'POST',
      `/api/libraries/${library.id}/access`,
      grantingAdmin.accessToken,
      { userId: user.id },
    );
    expect(grant.statusCode).toBe(204);

    const removal = await api('DELETE', `/api/users/${grantingAdmin.id}`, admin.accessToken);
    expect(removal.statusCode).toBe(204);

    const response = await api('GET', `/api/libraries/${library.id}/access`, admin.accessToken);
    expect(response.statusCode).toBe(200);
    const users = response.json<{ users: AccessListEntry[] }>().users;
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: user.id, username: user.username, grantedBy: null });
    // The grant row itself survives; only grantedById was nulled.
    expect((await grantRows(user.id))[0]?.grantedById).toBeNull();
  });

  it('returns 404 for an unknown library', async () => {
    const response = await api('GET', '/api/libraries/no-such-library/access', admin.accessToken);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});

describe('enforcement integration', () => {
  it('grants and revocations are reflected immediately in what a user can browse', async () => {
    const user = await registerUser();
    const [a, b] = [await createLibrary(), await createLibrary()];

    const before = await api('GET', '/api/libraries', user.accessToken);
    expect(before.statusCode).toBe(200);
    expect(before.json<{ libraries: unknown[] }>().libraries).toEqual([]);

    const bulk = await api('PUT', `/api/users/${user.id}/libraries`, admin.accessToken, {
      libraryIds: [a.id, b.id],
    });
    expect(bulk.statusCode).toBe(200);

    const granted = await api('GET', '/api/libraries', user.accessToken);
    expect(
      granted
        .json<{ libraries: Array<{ id: string }> }>()
        .libraries.map((library) => library.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());

    const revoke = await api(
      'DELETE',
      `/api/libraries/${a.id}/access/${user.id}`,
      admin.accessToken,
    );
    expect(revoke.statusCode).toBe(204);

    const after = await api('GET', '/api/libraries', user.accessToken);
    expect(
      after.json<{ libraries: Array<{ id: string }> }>().libraries.map((library) => library.id),
    ).toEqual([b.id]);
  });
});
