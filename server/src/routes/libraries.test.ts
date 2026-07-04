import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for the library management API against a real temporary
// SQLite database and a real temporary MEDIA_ROOTS directory tree (including
// real symlinks for the escape cases). The first registered user is the
// admin; extra users are registered per test as needed.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string; // canonical (realpath) temp dir
let mediaRoot: string; // <tempDir>/media — the single configured media root
let outsideDir: string; // <tempDir>/outside — exists but is not under a root
let prisma: PrismaClient;
let app: FastifyInstance;

interface LibraryResponse {
  id: string;
  name: string;
  type: string;
  paths: string[];
  createdAt: string;
  updatedAt: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface Session {
  id: string;
  username: string;
  accessToken: string;
}

let admin: Session; // primary admin (first registered user)

function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
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

/** Creates a unique directory inside the media root, returns its path. */
async function makeMediaDir(): Promise<string> {
  const dir = path.join(mediaRoot, `dir-${randomUUID().slice(0, 8)}`);
  await mkdir(dir);
  return dir;
}

function libraryName(): string {
  return `Library ${randomUUID().slice(0, 8)}`;
}

/** Creates a library through the API and returns the response body. */
async function createLibrary(
  overrides: Partial<{ name: string; type: string; paths: string[] }> = {},
): Promise<LibraryResponse> {
  const payload = {
    name: overrides.name ?? libraryName(),
    type: overrides.type ?? 'movies',
    paths: overrides.paths ?? [await makeMediaDir()],
  };
  const response = await api('POST', '/api/libraries', admin.accessToken, payload);
  expect(response.statusCode).toBe(201);
  return response.json<{ library: LibraryResponse }>().library;
}

/** Grants a user access to a library directly in the database. */
function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-libraries-test-')));
  mediaRoot = path.join(tempDir, 'media');
  outsideDir = path.join(tempDir, 'outside');
  await mkdir(mediaRoot);
  await mkdir(outsideDir);

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
  it('rejects non-admins with 403 FORBIDDEN on every mutating route', async () => {
    const user = await registerUser();
    const library = await createLibrary();
    await grantAccess(user.id, library.id); // access is not enough to mutate

    const routes: Array<['POST' | 'PATCH' | 'DELETE', string, Record<string, unknown>]> = [
      ['POST', '/api/libraries', { name: libraryName(), type: 'movies', paths: [mediaRoot] }],
      ['PATCH', `/api/libraries/${library.id}`, { name: libraryName() }],
      ['DELETE', `/api/libraries/${library.id}`, {}],
    ];
    for (const [method, url, payload] of routes) {
      const response = await api(method, url, user.accessToken, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
    }
  });

  it('rejects unauthenticated requests with 401 on every route', async () => {
    for (const [method, url] of [
      ['GET', '/api/libraries'],
      ['GET', '/api/libraries/some-id'],
      ['POST', '/api/libraries'],
      ['PATCH', '/api/libraries/some-id'],
      ['DELETE', '/api/libraries/some-id'],
    ] as const) {
      const response = await api(method, url);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('POST /api/libraries', () => {
  it('creates a library, storing paths in canonical form, and audits', async () => {
    const dir = await makeMediaDir();
    const messy = `${path.join(dir, '..', path.basename(dir))}${path.sep}`;
    const name = libraryName();

    const response = await api('POST', '/api/libraries', admin.accessToken, {
      name,
      type: 'tv',
      paths: [messy],
    });

    expect(response.statusCode).toBe(201);
    const library = response.json<{ library: LibraryResponse }>().library;
    expect(library).toMatchObject({ name, type: 'tv', paths: [dir] });

    const rows = await prisma.libraryPath.findMany({ where: { libraryId: library.id } });
    expect(rows.map((row) => row.path)).toEqual([dir]);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'library.created', targetId: library.id },
    });
    expect(audit?.userId).toBe(admin.id);
    expect(JSON.parse(audit!.details!)).toMatchObject({ name, type: 'tv', paths: [dir] });
  });

  it('stores the canonical target of a symlink that stays inside the roots', async () => {
    const target = await makeMediaDir();
    const link = path.join(mediaRoot, `link-${randomUUID().slice(0, 8)}`);
    await symlink(target, link);

    const library = await createLibrary({ paths: [link] });

    expect(library.paths).toEqual([target]);
  });

  it('accepts multiple paths and returns them sorted', async () => {
    const [a, b] = [await makeMediaDir(), await makeMediaDir()].sort();

    const library = await createLibrary({ paths: [b!, a!] });

    expect(library.paths).toEqual([a, b]);
  });

  it('rejects invalid bodies with 400 VALIDATION', async () => {
    const dir = await makeMediaDir();
    for (const payload of [
      {},
      { name: '', type: 'movies', paths: [dir] },
      { name: 'Bad Type', type: 'music', paths: [dir] },
      { name: 'No Paths', type: 'movies', paths: [] },
      { name: 'Bad Paths', type: 'movies', paths: 'not-an-array' },
    ]) {
      const response = await api('POST', '/api/libraries', admin.accessToken, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
    }
  });

  it.each([
    ['a relative path', 'relative/movies', /absolute/],
    ['a nonexistent path', '__MEDIA__/does-not-exist', /does not exist/],
    ['a file instead of a directory', '__FILE__', /not a directory/],
    ['a directory outside the media roots', '__OUTSIDE__', /outside the configured media roots/],
  ])('rejects %s with 400 INVALID_PATH', async (_label, candidate, messagePattern) => {
    const file = path.join(mediaRoot, `file-${randomUUID().slice(0, 8)}.mkv`);
    await writeFile(file, 'not a directory');
    const resolved = candidate
      .replace('__MEDIA__', mediaRoot)
      .replace('__FILE__', file)
      .replace('__OUTSIDE__', outsideDir);

    const response = await api('POST', '/api/libraries', admin.accessToken, {
      name: libraryName(),
      type: 'movies',
      paths: [resolved],
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toMatch(messagePattern);
  });

  it('rejects a symlink inside the roots that points outside with 400 INVALID_PATH', async () => {
    const escape = path.join(mediaRoot, `sneaky-${randomUUID().slice(0, 8)}`);
    await symlink(outsideDir, escape);

    const response = await api('POST', '/api/libraries', admin.accessToken, {
      name: libraryName(),
      type: 'movies',
      paths: [escape],
    });

    expect(response.statusCode).toBe(400);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe('INVALID_PATH');
    expect(error.message).toMatch(/outside the configured media roots/);
    expect(await prisma.libraryPath.findFirst({ where: { path: outsideDir } })).toBeNull();
  });

  it('rejects a duplicate name with 409 NAME_TAKEN', async () => {
    const existing = await createLibrary();

    const response = await api('POST', '/api/libraries', admin.accessToken, {
      name: existing.name,
      type: 'movies',
      paths: [await makeMediaDir()],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('NAME_TAKEN');
  });

  it('rejects a path already claimed by another library with 409 PATH_IN_USE', async () => {
    const dir = await makeMediaDir();
    await createLibrary({ paths: [dir] });

    const response = await api('POST', '/api/libraries', admin.accessToken, {
      name: libraryName(),
      type: 'movies',
      paths: [dir],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('PATH_IN_USE');
  });

  it('rejects duplicate paths within one request (after canonicalisation)', async () => {
    const dir = await makeMediaDir();

    const response = await api('POST', '/api/libraries', admin.accessToken, {
      name: libraryName(),
      type: 'movies',
      paths: [dir, `${dir}${path.sep}`], // same directory spelt two ways
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('PATH_IN_USE');
  });
});

describe('GET /api/libraries', () => {
  it('shows admins every library, ordered by name', async () => {
    const b = await createLibrary({ name: `B ${randomUUID().slice(0, 8)}` });
    const a = await createLibrary({ name: `A ${randomUUID().slice(0, 8)}` });

    const response = await api('GET', '/api/libraries', admin.accessToken);

    expect(response.statusCode).toBe(200);
    const libraries = response.json<{ libraries: LibraryResponse[] }>().libraries;
    const allIds = (await prisma.library.findMany({ select: { id: true } })).map((l) => l.id);
    expect(libraries.map((l) => l.id).sort()).toEqual(allIds.sort());
    expect(libraries.map((l) => l.name)).toEqual(libraries.map((l) => l.name).sort());
    expect(libraries.findIndex((l) => l.id === a.id)).toBeLessThan(
      libraries.findIndex((l) => l.id === b.id),
    );
    // Paths are included — this response powers the admin sidebar/UI.
    expect(libraries.find((l) => l.id === a.id)!.paths).toEqual(a.paths);
  });

  it('shows users only their granted libraries, and none without grants', async () => {
    const granted = await createLibrary();
    await createLibrary(); // exists but never granted
    const user = await registerUser();

    const before = await api('GET', '/api/libraries', user.accessToken);
    expect(before.statusCode).toBe(200);
    expect(before.json<{ libraries: LibraryResponse[] }>().libraries).toEqual([]);

    await grantAccess(user.id, granted.id);

    const after = await api('GET', '/api/libraries', user.accessToken);
    expect(after.statusCode).toBe(200);
    const libraries = after.json<{ libraries: LibraryResponse[] }>().libraries;
    expect(libraries.map((l) => l.id)).toEqual([granted.id]);
    expect(libraries[0]!.paths).toEqual(granted.paths);
  });
});

describe('GET /api/libraries/:id', () => {
  it('returns a granted library to a user and any library to an admin', async () => {
    const library = await createLibrary();
    const user = await registerUser();
    await grantAccess(user.id, library.id);

    for (const token of [user.accessToken, admin.accessToken]) {
      const response = await api('GET', `/api/libraries/${library.id}`, token);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ library: LibraryResponse }>().library).toMatchObject({
        id: library.id,
        name: library.name,
        type: library.type,
        paths: library.paths,
      });
    }
  });

  it('404s identically (byte-for-byte) for missing and ungranted libraries', async () => {
    const ungrantedLibrary = await createLibrary();
    const user = await registerUser();

    const missing = await api('GET', '/api/libraries/no-such-library', user.accessToken);
    const ungranted = await api('GET', `/api/libraries/${ungrantedLibrary.id}`, user.accessToken);

    expect(missing.statusCode).toBe(404);
    expect(ungranted.statusCode).toBe(404);
    // Byte-identical bodies: the response must never reveal whether an id
    // exists in a library the caller cannot see.
    expect(ungranted.body).toBe(missing.body);
    expect(missing.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    // Admins can of course still see it.
    const asAdmin = await api('GET', `/api/libraries/${ungrantedLibrary.id}`, admin.accessToken);
    expect(asAdmin.statusCode).toBe(200);
  });
});

describe('PATCH /api/libraries/:id', () => {
  it('renames a library and enforces name uniqueness', async () => {
    const other = await createLibrary();
    const library = await createLibrary();
    const newName = libraryName();

    const rename = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      name: newName,
    });
    expect(rename.statusCode).toBe(200);
    const renamed = rename.json<{ library: LibraryResponse }>().library;
    expect(renamed.name).toBe(newName);
    expect(renamed.paths).toEqual(library.paths); // untouched

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'library.updated', targetId: library.id },
    });
    expect(audit?.userId).toBe(admin.id);
    expect(JSON.parse(audit!.details!)).toEqual({ name: { from: library.name, to: newName } });

    const clash = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      name: other.name,
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json<ErrorBody>().error.code).toBe('NAME_TAKEN');
  });

  it('replaces the path set (validated and canonicalised) and audits the change', async () => {
    const original = await makeMediaDir();
    const library = await createLibrary({ paths: [original] });
    const [kept, added] = [await makeMediaDir(), await makeMediaDir()].sort();

    const response = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      paths: [`${added!}${path.sep}`, kept!],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ library: LibraryResponse }>().library.paths).toEqual([kept, added]);
    const rows = await prisma.libraryPath.findMany({ where: { libraryId: library.id } });
    expect(rows.map((row) => row.path).sort()).toEqual([kept, added]);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'library.updated', targetId: library.id },
      orderBy: { createdAt: 'desc' },
    });
    const details = JSON.parse(audit!.details!) as { paths: { from: string[]; to: string[] } };
    expect(details.paths.from).toEqual([original]);
    expect(details.paths.to.sort()).toEqual([kept, added]);

    // The freed-up original path can now be claimed by a new library.
    const reuse = await createLibrary({ paths: [original] });
    expect(reuse.paths).toEqual([original]);
  });

  it('rejects paths claimed by another library with 409 PATH_IN_USE but keeps own paths', async () => {
    const otherDir = await makeMediaDir();
    await createLibrary({ paths: [otherDir] });
    const ownDir = await makeMediaDir();
    const library = await createLibrary({ paths: [ownDir] });

    const stolen = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      paths: [otherDir],
    });
    expect(stolen.statusCode).toBe(409);
    expect(stolen.json<ErrorBody>().error.code).toBe('PATH_IN_USE');

    // Re-submitting its own path is not a conflict (replace is idempotent).
    const keep = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      paths: [ownDir],
    });
    expect(keep.statusCode).toBe(200);
    expect(keep.json<{ library: LibraryResponse }>().library.paths).toEqual([ownDir]);
  });

  it('rejects invalid replacement paths with 400 INVALID_PATH and changes nothing', async () => {
    const dir = await makeMediaDir();
    const library = await createLibrary({ paths: [dir] });

    const response = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      paths: [outsideDir],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('INVALID_PATH');
    const rows = await prisma.libraryPath.findMany({ where: { libraryId: library.id } });
    expect(rows.map((row) => row.path)).toEqual([dir]);
  });

  it('rejects a type change with 400 TYPE_IMMUTABLE (same type is a no-op)', async () => {
    const library = await createLibrary({ type: 'movies' });

    const change = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      type: 'anime',
    });
    expect(change.statusCode).toBe(400);
    expect(change.json<ErrorBody>().error.code).toBe('TYPE_IMMUTABLE');
    const dbLibrary = await prisma.library.findUniqueOrThrow({ where: { id: library.id } });
    expect(dbLibrary.type).toBe('movies');

    const same = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {
      type: 'movies',
      name: libraryName(),
    });
    expect(same.statusCode).toBe(200);
  });

  it('rejects an empty body with 400 VALIDATION and a missing id with 404', async () => {
    const library = await createLibrary();

    const empty = await api('PATCH', `/api/libraries/${library.id}`, admin.accessToken, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json<ErrorBody>().error.code).toBe('VALIDATION');

    const missing = await api('PATCH', '/api/libraries/no-such-library', admin.accessToken, {
      name: libraryName(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/libraries/:id', () => {
  it('deletes a library, cascading media items, paths and grants, and audits', async () => {
    const library = await createLibrary();
    const user = await registerUser();
    await grantAccess(user.id, library.id);
    const item = await prisma.mediaItem.create({
      data: { libraryId: library.id, type: 'movie', title: 'Cascade Me', sortTitle: 'cascade me' },
    });

    const response = await api('DELETE', `/api/libraries/${library.id}`, admin.accessToken);

    expect(response.statusCode).toBe(204);
    expect(await prisma.library.findUnique({ where: { id: library.id } })).toBeNull();
    expect(await prisma.mediaItem.findUnique({ where: { id: item.id } })).toBeNull();
    expect(await prisma.libraryPath.count({ where: { libraryId: library.id } })).toBe(0);
    expect(await prisma.libraryAccess.count({ where: { libraryId: library.id } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'library.deleted', targetId: library.id },
    });
    expect(audit?.userId).toBe(admin.id);
    expect(JSON.parse(audit!.details!)).toMatchObject({
      name: library.name,
      type: library.type,
      paths: library.paths,
    });
  });

  it('returns 404 for a missing library', async () => {
    const response = await api('DELETE', '/api/libraries/no-such-library', admin.accessToken);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});
