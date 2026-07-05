import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import { isPathWithin } from '../lib/media-roots.js';

// SQLite hot backup via `VACUUM INTO`. Unlike a raw file copy, VACUUM INTO
// produces a consistent, defragmented snapshot even while the server is
// writing, without stopping the world. Backups land in ${CONFIG_DIR}/backups
// as `aura-<timestamp>.db`; the newest BACKUP_RETENTION are kept and older ones
// pruned.

/** Basename of the backup subdirectory under CONFIG_DIR. */
export const BACKUP_SUBDIR = 'backups';

/** Prefix + extension of a backup filename: aura-<ts>.db. */
const BACKUP_PREFIX = 'aura-';
const BACKUP_EXT = '.db';

/** Matches backup filenames this task produces (for the prune pass). */
const BACKUP_NAME_RE = /^aura-[0-9TZ.:-]+\.db$/;

/** Directory database backups live under for a given CONFIG_DIR. */
export function backupsDir(configDir: string): string {
  return path.join(configDir, BACKUP_SUBDIR);
}

/** Turns a timestamp into a filesystem-safe backup filename. */
function backupFileName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `${BACKUP_PREFIX}${stamp}${BACKUP_EXT}`;
}

export interface PruneBackupsResult {
  /** Backup filenames deleted this run. */
  deleted: string[];
  /** Backup filenames retained. */
  retained: string[];
}

/**
 * Keeps the newest `retention` backups in `dir` and deletes the rest. Newness
 * is by filename, which sorts chronologically because the timestamp is a
 * zero-padded ISO string. Never throws for per-file failures.
 */
export async function pruneBackups(
  dir: string,
  retention: number,
  log?: FastifyBaseLogger,
): Promise<PruneBackupsResult> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { deleted: [], retained: [] };
  }
  const backups = names.filter((name) => BACKUP_NAME_RE.test(name)).sort();
  const keep = Math.max(0, retention);
  const retained = backups.slice(Math.max(0, backups.length - keep));
  const doomed = backups.slice(0, Math.max(0, backups.length - keep));

  const deleted: string[] = [];
  for (const name of doomed) {
    try {
      await rm(path.join(dir, name), { force: true });
      deleted.push(name);
    } catch (err) {
      log?.warn({ err, backup: name }, 'db-backup: failed to prune old backup');
    }
  }
  return { deleted, retained };
}

export interface BackupDatabaseOptions {
  /** CONFIG_DIR — backups land in `${configDir}/backups`. */
  configDir: string;
  /** Number of most-recent backups to retain after this run. */
  retention: number;
  /** Prisma client whose SQLite database is backed up. Defaults to the shared one. */
  prisma?: PrismaClient;
  /** Backup timestamp (ms), used in the filename. Defaults to Date.now. */
  now?: number;
  log?: FastifyBaseLogger;
}

export interface BackupDatabaseResult {
  /** Absolute path of the backup just written. */
  backupPath: string;
  /** Size of the backup file in bytes. */
  backupBytes: number;
  /** Backup filenames pruned by the retention pass. */
  pruned: string[];
  /** Backup filenames retained (including the one just written). */
  retained: string[];
}

/**
 * Writes a consistent SQLite snapshot to `${configDir}/backups/aura-<ts>.db`
 * via `VACUUM INTO`, then prunes older backups beyond `retention`.
 *
 * @throws if the target path escapes the backups dir (never, given the
 *   server-generated filename — a defence-in-depth guard) or if VACUUM fails.
 */
export async function backupDatabase(
  options: BackupDatabaseOptions,
): Promise<BackupDatabaseResult> {
  const prisma = options.prisma ?? getPrisma();
  const dir = backupsDir(options.configDir);
  await mkdir(dir, { recursive: true });

  const target = path.join(dir, backupFileName(options.now ?? Date.now()));
  // Defence in depth: the filename is server-generated, but assert containment
  // before handing the path to SQLite anyway.
  if (!isPathWithin(target, dir)) {
    throw new Error('db-backup: refusing to write backup outside the backups dir');
  }
  // VACUUM INTO fails if the destination already exists; clear a same-timestamp
  // collision (only possible when two runs share an injected `now`).
  await rm(target, { force: true });

  // VACUUM INTO evaluates its target as an expression, so a bound parameter is
  // accepted — no path is ever interpolated into SQL.
  await prisma.$executeRawUnsafe('VACUUM INTO ?', target);

  const backupBytes = (await stat(target)).size;
  const { deleted, retained } = await pruneBackups(dir, options.retention, options.log);

  options.log?.info(
    { backupPath: target, backupBytes, pruned: deleted.length },
    'db-backup: wrote database snapshot',
  );
  return { backupPath: target, backupBytes, pruned: deleted, retained };
}
