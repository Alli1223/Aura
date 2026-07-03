import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Library, PrismaClient, User } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import {
  assertLibraryAccess,
  assertMediaItemAccess,
  canAccessLibrary,
  getAccessibleLibraryIds,
} from './access.js';
import { toAuthUser, type AuthUser } from './types.js';

// Tests for the library access enforcement helpers against a real temporary
// SQLite database (migrations applied with `prisma migrate deploy`).

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;

// Fixtures shared by all tests (read-only unless a test says otherwise).
let admin: AuthUser;
let grantedUser: AuthUser;
let ungrantedUser: AuthUser;
let disabledUser: AuthUser; // has a grant to libraryA, but is disabled
let disabledAdmin: AuthUser;
let libraryA: Library; // grantedUser + disabledUser have grants
let libraryB: Library; // nobody has a grant
let movieInA: { id: string; title: string };
let movieInB: { id: string };

async function createUser(overrides: Partial<User> = {}): Promise<AuthUser> {
  const user = await prisma.user.create({
    data: {
      username: `user-${randomUUID()}`,
      passwordHash: 'argon2id$fake-hash',
      ...overrides,
    },
  });
  return toAuthUser(user);
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

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-access-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();

  admin = await createUser({ role: 'admin' });
  grantedUser = await createUser();
  ungrantedUser = await createUser();
  disabledUser = await createUser({ isEnabled: false });
  disabledAdmin = await createUser({ role: 'admin', isEnabled: false });

  libraryA = await createLibrary('movies');
  libraryB = await createLibrary('tv');

  await prisma.libraryAccess.create({
    data: { userId: grantedUser.id, libraryId: libraryA.id, grantedById: admin.id },
  });
  await prisma.libraryAccess.create({
    data: { userId: disabledUser.id, libraryId: libraryA.id, grantedById: admin.id },
  });

  movieInA = await prisma.mediaItem.create({
    data: { libraryId: libraryA.id, type: 'movie', title: 'Granted Movie', sortTitle: 'granted' },
  });
  movieInB = await prisma.mediaItem.create({
    data: { libraryId: libraryB.id, type: 'movie', title: 'Secret Movie', sortTitle: 'secret' },
  });
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

/** Captures the ApiError a helper throws (fails the test if it doesn't). */
async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  expect.unreachable('expected the helper to throw an ApiError');
}

describe('getAccessibleLibraryIds', () => {
  it('returns every library id for an admin', async () => {
    const all = await prisma.library.findMany({ select: { id: true } });

    const ids = await getAccessibleLibraryIds(admin);

    expect([...ids].sort()).toEqual(all.map((l) => l.id).sort());
    expect(ids).toContain(libraryA.id);
    expect(ids).toContain(libraryB.id);
  });

  it('returns only granted library ids for a user', async () => {
    const ids = await getAccessibleLibraryIds(grantedUser);

    expect(ids).toEqual([libraryA.id]);
  });

  it('returns an empty list for a user with no grants', async () => {
    expect(await getAccessibleLibraryIds(ungrantedUser)).toEqual([]);
  });

  it('returns an empty list for disabled users regardless of role or grants', async () => {
    expect(await getAccessibleLibraryIds(disabledUser)).toEqual([]);
    expect(await getAccessibleLibraryIds(disabledAdmin)).toEqual([]);
  });
});

describe('canAccessLibrary', () => {
  it('lets an admin access any library, even ids that do not exist', async () => {
    expect(await canAccessLibrary(admin, libraryA.id)).toBe(true);
    expect(await canAccessLibrary(admin, libraryB.id)).toBe(true);
    expect(await canAccessLibrary(admin, 'no-such-library')).toBe(true);
  });

  it('lets a user access granted libraries only', async () => {
    expect(await canAccessLibrary(grantedUser, libraryA.id)).toBe(true);
    expect(await canAccessLibrary(grantedUser, libraryB.id)).toBe(false);
    expect(await canAccessLibrary(grantedUser, 'no-such-library')).toBe(false);
  });

  it('denies a user with no grants', async () => {
    expect(await canAccessLibrary(ungrantedUser, libraryA.id)).toBe(false);
  });

  it('denies disabled users even with a grant or the admin role', async () => {
    expect(await canAccessLibrary(disabledUser, libraryA.id)).toBe(false);
    expect(await canAccessLibrary(disabledAdmin, libraryA.id)).toBe(false);
  });
});

describe('assertLibraryAccess', () => {
  it('resolves for an admin and for a granted user', async () => {
    await expect(assertLibraryAccess(admin, libraryB.id)).resolves.toBeUndefined();
    await expect(assertLibraryAccess(grantedUser, libraryA.id)).resolves.toBeUndefined();
  });

  it('throws the standard 403 FORBIDDEN for an ungranted library', async () => {
    const err = await captureApiError(assertLibraryAccess(grantedUser, libraryB.id));

    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('throws an identical 403 whether the library exists or not', async () => {
    const existing = await captureApiError(assertLibraryAccess(ungrantedUser, libraryA.id));
    const missing = await captureApiError(assertLibraryAccess(ungrantedUser, 'no-such-library'));

    expect(missing.statusCode).toBe(existing.statusCode);
    expect(missing.code).toBe(existing.code);
    expect(missing.message).toBe(existing.message);
  });

  it('throws 403 for disabled users', async () => {
    const err = await captureApiError(assertLibraryAccess(disabledUser, libraryA.id));

    expect(err.statusCode).toBe(403);
  });
});

describe('assertMediaItemAccess', () => {
  it('returns the full item for an admin and for a granted user', async () => {
    const forAdmin = await assertMediaItemAccess(admin, movieInB.id);
    expect(forAdmin.id).toBe(movieInB.id);

    // The returned row is complete so routes never need a second fetch.
    const forUser = await assertMediaItemAccess(grantedUser, movieInA.id);
    expect(forUser).toMatchObject({
      id: movieInA.id,
      libraryId: libraryA.id,
      type: 'movie',
      title: 'Granted Movie',
    });
  });

  it('throws 404 NOT_FOUND for a missing item', async () => {
    const err = await captureApiError(assertMediaItemAccess(admin, 'no-such-item'));

    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('throws 404 (not 403) for an item in an ungranted library, identical to the missing-item error, so ids cannot be enumerated', async () => {
    const forbidden = await captureApiError(assertMediaItemAccess(grantedUser, movieInB.id));
    const missing = await captureApiError(assertMediaItemAccess(grantedUser, 'no-such-item'));

    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.code).toBe('NOT_FOUND');
    expect(forbidden.statusCode).toBe(missing.statusCode);
    expect(forbidden.code).toBe(missing.code);
    expect(forbidden.message).toBe(missing.message);
  });

  it('throws 404 for disabled users even with a grant', async () => {
    const err = await captureApiError(assertMediaItemAccess(disabledUser, movieInA.id));

    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('grant revocation', () => {
  it('takes effect immediately — access checks are never cached', async () => {
    const user = await createUser();
    const library = await createLibrary('anime');
    const item = await prisma.mediaItem.create({
      data: { libraryId: library.id, type: 'movie', title: 'Ephemeral', sortTitle: 'ephemeral' },
    });

    await prisma.libraryAccess.create({ data: { userId: user.id, libraryId: library.id } });
    expect(await canAccessLibrary(user, library.id)).toBe(true);
    expect(await getAccessibleLibraryIds(user)).toEqual([library.id]);
    await expect(assertMediaItemAccess(user, item.id)).resolves.toMatchObject({ id: item.id });

    await prisma.libraryAccess.delete({
      where: { userId_libraryId: { userId: user.id, libraryId: library.id } },
    });

    expect(await canAccessLibrary(user, library.id)).toBe(false);
    expect(await getAccessibleLibraryIds(user)).toEqual([]);
    const libErr = await captureApiError(assertLibraryAccess(user, library.id));
    expect(libErr.statusCode).toBe(403);
    const itemErr = await captureApiError(assertMediaItemAccess(user, item.id));
    expect(itemErr.statusCode).toBe(404);
  });
});
