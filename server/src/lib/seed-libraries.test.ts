import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import { DEFAULT_LIBRARIES, seedDefaultLibraries } from './seed-libraries.js';

// Seeding tests against a real temporary SQLite database and real temporary
// media-root directories. Each test starts from an empty Library table and
// its own fresh media root so the "only when empty" and "only existing
// directories" rules are observable in isolation.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;

/** Creates a fresh media root containing the given default folder names. */
async function makeRoot(dirs: readonly string[]): Promise<string> {
  const root = path.join(tempDir, `root-${randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
  for (const dir of dirs) await mkdir(path.join(root, dir));
  return root;
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-seed-test-')));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
}, 120_000);

beforeEach(async () => {
  await prisma.library.deleteMany();
});

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('seedDefaultLibraries', () => {
  it('creates all five defaults with correct names, types and canonical paths', async () => {
    const root = await makeRoot(['movies', 'tv', 'anime', 'recordings', 'other']);

    const created = await seedDefaultLibraries([root]);

    expect(created).toHaveLength(5);
    const libraries = await prisma.library.findMany({
      include: { paths: true },
      orderBy: { name: 'asc' },
    });
    expect(libraries).toHaveLength(5);

    for (const expected of DEFAULT_LIBRARIES) {
      const library = libraries.find((l) => l.name === expected.name);
      expect(library, expected.name).toBeDefined();
      expect(library!.type).toBe(expected.type);
      expect(library!.paths.map((p) => p.path)).toEqual([path.join(root, expected.dir)]);
    }
    // No access grants are seeded: access is always an explicit admin action.
    expect(await prisma.libraryAccess.count()).toBe(0);
  });

  it('creates only the defaults whose directory exists', async () => {
    const root = await makeRoot(['movies', 'anime']);

    const created = await seedDefaultLibraries([root]);

    expect(created.map((l) => l.name).sort()).toEqual(['Anime', 'Movies']);
    const libraries = await prisma.library.findMany();
    expect(libraries.map((l) => l.type).sort()).toEqual(['anime', 'movies']);
  });

  it('is a no-op on a second call even when more directories appeared', async () => {
    const root = await makeRoot(['movies']);
    await seedDefaultLibraries([root]);
    await mkdir(path.join(root, 'tv'));

    const second = await seedDefaultLibraries([root]);

    expect(second).toEqual([]);
    expect(await prisma.library.count()).toBe(1);
  });

  it('is a no-op when the Library table already has any library', async () => {
    const root = await makeRoot(['movies', 'tv', 'anime', 'recordings', 'other']);
    await prisma.library.create({ data: { name: 'Existing', type: 'other' } });

    const created = await seedDefaultLibraries([root]);

    expect(created).toEqual([]);
    const libraries = await prisma.library.findMany();
    expect(libraries).toHaveLength(1);
    expect(libraries[0]!.name).toBe('Existing');
  });

  it('creates nothing when no default directory exists', async () => {
    const root = await makeRoot([]);

    expect(await seedDefaultLibraries([root])).toEqual([]);
    expect(await seedDefaultLibraries([])).toEqual([]);
    expect(await prisma.library.count()).toBe(0);
  });
});
