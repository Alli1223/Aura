import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../config.js';
import { getSetting } from '../lib/settings.js';
import { evictArtworkCache } from '../metadata/artwork-cache.js';
import { scanAllLibraries } from '../scanner/scan-scheduler.js';
import { backupDatabase } from './db-backup.js';
import type { Task } from './task-runner.js';
import { sweepTranscodeDir } from './transcode-cleanup.js';

// Wires the four built-in maintenance tasks over the existing scan / eviction /
// backup functions. Each task is a thin adapter: it reads its cadence and
// tunables from config and delegates the real work to the module that owns it.
// The runner (task-runner.ts) schedules and tracks them.

/** Task id constants (also the trigger-API path segment). */
export const TASK_IDS = {
  libraryScanAll: 'library-scan-all',
  transcodeCleanup: 'transcode-cleanup',
  artworkCacheEvict: 'artwork-cache-evict',
  dbBackup: 'db-backup',
} as const;

export interface BuiltInTasksOptions {
  config: Config;
  log?: FastifyBaseLogger;
}

/**
 * Builds the built-in task list from config. Each task's `enabled` reflects
 * whether its interval is positive (0 leaves it registered but unscheduled, so
 * it still appears in the status API and can be triggered manually).
 */
export function createBuiltInTasks({ config, log }: BuiltInTasksOptions): Task[] {
  const getTranscodeDir = (): Promise<string> => getSetting('transcodeDir', log);

  return [
    {
      // Migrated from the standalone ScanScheduler: same cadence
      // (SCAN_INTERVAL_MS), same scanAllLibraries helper, same skip-already-
      // scanning behaviour — now run as a task so all periodic work shares one
      // runner, status surface and shutdown path.
      id: TASK_IDS.libraryScanAll,
      name: 'Library scan (all)',
      intervalMs: config.SCAN_INTERVAL_MS,
      enabled: config.SCAN_INTERVAL_MS > 0,
      run: async () => {
        await scanAllLibraries({ mediaRoots: config.MEDIA_ROOTS, log });
        return { scope: 'all-libraries' };
      },
    },
    {
      id: TASK_IDS.transcodeCleanup,
      name: 'Transcode scratch cleanup',
      intervalMs: config.TRANSCODE_CLEANUP_INTERVAL_MS,
      enabled: config.TRANSCODE_CLEANUP_INTERVAL_MS > 0,
      run: async (ctx) =>
        sweepTranscodeDir({
          transcodeDir: await getTranscodeDir(),
          maxAgeMs: config.TRANSCODE_CLEANUP_MAX_AGE_MS,
          now: ctx.now,
          log,
        }),
    },
    {
      id: TASK_IDS.artworkCacheEvict,
      name: 'Artwork cache eviction',
      intervalMs: config.ARTWORK_EVICT_INTERVAL_MS,
      enabled: config.ARTWORK_EVICT_INTERVAL_MS > 0,
      run: async () =>
        evictArtworkCache({
          configDir: config.CONFIG_DIR,
          maxBytes: config.ARTWORK_CACHE_MAX_BYTES,
        }),
    },
    {
      id: TASK_IDS.dbBackup,
      name: 'Database backup',
      intervalMs: config.DB_BACKUP_INTERVAL_MS,
      enabled: config.DB_BACKUP_INTERVAL_MS > 0,
      run: async (ctx) =>
        backupDatabase({
          configDir: config.CONFIG_DIR,
          retention: config.BACKUP_RETENTION,
          now: ctx.now,
          log,
        }),
    },
  ];
}
