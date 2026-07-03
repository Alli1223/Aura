import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from './client.js';

// Integration tests against a real temporary SQLite database created by
// applying the committed migrations with `prisma migrate deploy`.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-db-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

function uniqueUser() {
  return {
    username: `user-${randomUUID()}`,
    passwordHash: 'argon2id$fake-hash',
  };
}

async function createLibraryWithPath(type = 'movies') {
  const suffix = randomUUID();
  return prisma.library.create({
    data: {
      name: `Library ${suffix}`,
      type,
      paths: { create: { path: `/media/${type}/${suffix}` } },
    },
  });
}

describe('client singleton', () => {
  it('returns the same instance on repeated calls', () => {
    expect(getPrisma()).toBe(prisma);
  });
});

describe('library access pivot', () => {
  it('grants access and queries libraries through the pivot', async () => {
    const admin = await prisma.user.create({
      data: { ...uniqueUser(), role: 'admin' },
    });
    const user = await prisma.user.create({ data: uniqueUser() });
    const granted = await createLibraryWithPath('movies');
    const notGranted = await createLibraryWithPath('tv');

    await prisma.libraryAccess.create({
      data: { userId: user.id, libraryId: granted.id, grantedById: admin.id },
    });

    const accessible = await prisma.library.findMany({
      where: {
        id: { in: [granted.id, notGranted.id] },
        access: { some: { userId: user.id } },
      },
    });

    expect(accessible.map((l) => l.id)).toEqual([granted.id]);
  });

  it('new users have no library access by default', async () => {
    const user = await prisma.user.create({ data: uniqueUser() });
    await createLibraryWithPath('anime');

    const accessible = await prisma.library.findMany({
      where: { access: { some: { userId: user.id } } },
    });

    expect(accessible).toHaveLength(0);
  });
});

describe('unique constraints', () => {
  it('rejects duplicate usernames', async () => {
    const data = uniqueUser();
    await prisma.user.create({ data });

    await expect(prisma.user.create({ data })).rejects.toSatisfy(
      (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
    );
  });

  it('rejects duplicate library access grants', async () => {
    const user = await prisma.user.create({ data: uniqueUser() });
    const library = await createLibraryWithPath();
    const grant = { userId: user.id, libraryId: library.id };

    await prisma.libraryAccess.create({ data: grant });

    await expect(prisma.libraryAccess.create({ data: grant })).rejects.toSatisfy(
      (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002',
    );
  });
});

describe('cascade deletes', () => {
  it('deleting a show deletes its seasons and episodes', async () => {
    const library = await createLibraryWithPath('tv');
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
    const episode = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'episode',
        parentId: season.id,
        title: 'Pilot',
        sortTitle: 'pilot',
        seasonNumber: 1,
        episodeNumber: 1,
      },
    });
    await prisma.mediaFile.create({
      data: {
        mediaItemId: episode.id,
        path: `/media/tv/${randomUUID()}/S01E01.mkv`,
        size: 1_000_000n,
        mtimeMs: 1_700_000_000_000n,
        streams: {
          create: { streamIndex: 0, type: 'video', codec: 'h264' },
        },
      },
    });

    await prisma.mediaItem.delete({ where: { id: show.id } });

    const remainingItems = await prisma.mediaItem.count({
      where: { id: { in: [show.id, season.id, episode.id] } },
    });
    expect(remainingItems).toBe(0);
    expect(await prisma.mediaFile.count({ where: { mediaItemId: episode.id } })).toBe(0);
    expect(await prisma.mediaStream.count()).toBe(0);
  });

  it('deleting a user deletes their grants, sessions and watch states', async () => {
    const user = await prisma.user.create({ data: uniqueUser() });
    const library = await createLibraryWithPath();
    const movie = await prisma.mediaItem.create({
      data: { libraryId: library.id, type: 'movie', title: 'Movie', sortTitle: 'movie' },
    });

    await prisma.libraryAccess.create({
      data: { userId: user.id, libraryId: library.id },
    });
    await prisma.refreshSession.create({
      data: {
        userId: user.id,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.watchState.create({
      data: { userId: user.id, mediaItemId: movie.id, positionMs: 1_000 },
    });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.libraryAccess.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.watchState.count({ where: { userId: user.id } })).toBe(0);
    // The library and media item survive.
    expect(await prisma.library.count({ where: { id: library.id } })).toBe(1);
    expect(await prisma.mediaItem.count({ where: { id: movie.id } })).toBe(1);
  });

  it('deleting a user keeps grants they issued, with grantedById nulled', async () => {
    const admin = await prisma.user.create({ data: { ...uniqueUser(), role: 'admin' } });
    const user = await prisma.user.create({ data: uniqueUser() });
    const library = await createLibraryWithPath();
    const grant = await prisma.libraryAccess.create({
      data: { userId: user.id, libraryId: library.id, grantedById: admin.id },
    });

    await prisma.user.delete({ where: { id: admin.id } });

    const survivor = await prisma.libraryAccess.findUniqueOrThrow({ where: { id: grant.id } });
    expect(survivor.grantedById).toBeNull();
  });
});

describe('watch state', () => {
  it('upserts by the (userId, mediaItemId) composite key', async () => {
    const user = await prisma.user.create({ data: uniqueUser() });
    const library = await createLibraryWithPath();
    const movie = await prisma.mediaItem.create({
      data: { libraryId: library.id, type: 'movie', title: 'Movie', sortTitle: 'movie' },
    });
    const key = { userId: user.id, mediaItemId: movie.id };

    await prisma.watchState.upsert({
      where: { userId_mediaItemId: key },
      create: { ...key, positionMs: 60_000, playCount: 1 },
      update: { positionMs: 60_000, playCount: { increment: 1 } },
    });
    await prisma.watchState.upsert({
      where: { userId_mediaItemId: key },
      create: { ...key, positionMs: 120_000, playCount: 1 },
      update: {
        positionMs: 120_000,
        playCount: { increment: 1 },
        watched: true,
        watchedAt: new Date(),
      },
    });

    const states = await prisma.watchState.findMany({ where: { userId: user.id } });
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ positionMs: 120_000, playCount: 2, watched: true });
    expect(states[0]!.watchedAt).toBeInstanceOf(Date);
  });
});

describe('media files', () => {
  it('round-trips BigInt sizes and mtimes', async () => {
    const library = await createLibraryWithPath();
    const movie = await prisma.mediaItem.create({
      data: { libraryId: library.id, type: 'movie', title: 'Big', sortTitle: 'big' },
    });
    const size = 5_368_709_120n; // 5 GiB — larger than a 32-bit int.
    const mtimeMs = 1_751_500_000_123n;

    const created = await prisma.mediaFile.create({
      data: {
        mediaItemId: movie.id,
        path: `/media/movies/${randomUUID()}/big.mkv`,
        size,
        mtimeMs,
      },
    });
    const found = await prisma.mediaFile.findUniqueOrThrow({ where: { id: created.id } });

    expect(found.size).toBe(size);
    expect(found.mtimeMs).toBe(mtimeMs);
    expect(found.status).toBe('available');
  });
});
