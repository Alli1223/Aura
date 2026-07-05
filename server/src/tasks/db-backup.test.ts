import { execSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import { backupDatabase, backupsDir, pruneBackups } from './db-backup.js';

// Backs up a real temporary SQLite database via VACUUM INTO and asserts the
// snapshot is a valid SQLite file, retention prunes the oldest, and every
// backup path stays inside the backups dir.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** First 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = 'SQLite format 3\u0000';

let tempDir: string;
let configDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-db-backup-test-')));
  configDir = path.join(tempDir, 'config');

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
  // Give the DB some content so the backup is a meaningful copy.
  await prisma.setting.create({ data: { key: 'serverName', value: JSON.stringify('Aura') } });
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  it('writes a valid SQLite snapshot inside the backups dir', async () => {
    const result = await backupDatabase({ configDir, retention: 7, prisma, now: Date.now() });

    const dir = backupsDir(configDir);
    expect(result.backupPath.startsWith(dir + path.sep)).toBe(true);
    expect(result.backupBytes).toBeGreaterThan(0);

    const header = (await readFile(result.backupPath)).subarray(0, 16).toString('binary');
    expect(header).toBe(SQLITE_MAGIC);
    expect(result.retained).toContain(path.basename(result.backupPath));
  });

  it('retains only the newest N backups, pruning the oldest', async () => {
    const dir = backupsDir(configDir);
    // Clear anything from earlier tests.
    for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true });

    const base = Date.now();
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await backupDatabase({
        configDir,
        retention: 3,
        prisma,
        // Distinct, increasing timestamps => distinct, chronologically sorted names.
        now: base + i * 1000,
      });
      created.push(path.basename(result.backupPath));
    }

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toHaveLength(3);
    // The three newest survive; the two oldest were pruned.
    expect(remaining).toEqual(created.slice(2).sort());
    expect(remaining).not.toContain(created[0]);
    expect(remaining).not.toContain(created[1]);
  });
});

describe('pruneBackups', () => {
  it('keeps the newest N by filename and ignores non-backup files', async () => {
    const dir = backupsDir(configDir);
    for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true });
    for (const name of [
      'aura-1.db',
      'aura-2.db',
      'aura-3.db',
      'aura-4.db',
      'aura-5.db',
      'notes.txt',
    ]) {
      await writeFile(path.join(dir, name), 'x');
    }

    const result = await pruneBackups(dir, 2);

    expect(result.retained.sort()).toEqual(['aura-4.db', 'aura-5.db']);
    expect(result.deleted.sort()).toEqual(['aura-1.db', 'aura-2.db', 'aura-3.db']);
    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(['aura-4.db', 'aura-5.db', 'notes.txt']);
  });
});
