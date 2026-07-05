import type { Dirent } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

// Transcode scratch cleanup. The HLS session manager already removes its own
// scratch dirs on stop/idle-reap/shutdown; this task is the safety net that
// reclaims dirs orphaned by a crash (the process died mid-session and restarted
// with no memory of the old dirs).
//
// Layout under transcodeDir (see hls-session.ts + streaming/subtitles.ts):
//   <transcodeDir>/<sessionId>/            HLS session scratch (playlist+segments)
//   <transcodeDir>/subtitles/<fileId>/     WebVTT subtitle cache (per media file)
//
// A dir is removed when it is OLDER than maxAgeMs (measured by the newest mtime
// among the dir and its immediate children, so an actively-growing session
// counts as fresh) and not protected by the optional `isLive` predicate.
//
// Safety: with maxAgeMs kept above HLS_SESSION_IDLE_MS (enforced by config
// defaults), any dir old enough to sweep has been untouched far longer than the
// idle reaper's window, so it cannot belong to a live/starting session — pure
// age is sufficient. `isLive` is defence-in-depth for callers that can supply a
// live-session set.

/** Basename of the subtitle cache subtree under the transcode dir. */
export const SUBTITLE_SUBDIR = 'subtitles';

export interface SweepTranscodeDirOptions {
  /** Root scratch directory (settings.transcodeDir). */
  transcodeDir: string;
  /** A dir (or subtitle entry) is removed when older than this, in ms. */
  maxAgeMs: number;
  /** Current time in ms; defaults to Date.now (injected in tests). */
  now?: number;
  /**
   * Protects a top-level entry from removal by its basename (e.g. live HLS
   * session ids). Defaults to protecting nothing.
   */
  isLive?: (dirName: string) => boolean;
  log?: FastifyBaseLogger;
}

export interface SweepTranscodeDirResult {
  /** Directories removed this run (relative to transcodeDir). */
  removed: string[];
  /** Bytes freed (best-effort sum of removed files' sizes). */
  freedBytes: number;
  /** Entries skipped because they were live or still fresh. */
  kept: number;
}

/** Newest mtime (ms) among `dir` and its immediate children. */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;
  try {
    newest = (await stat(dir)).mtimeMs;
  } catch {
    return 0;
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return newest;
  }
  for (const entry of entries) {
    try {
      const s = await stat(path.join(dir, entry));
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {
      // Vanished mid-sweep — ignore.
    }
  }
  return newest;
}

/** Recursively totals the byte size of a directory (best-effort). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await dirSize(full);
      } else if (entry.isFile()) {
        total += (await stat(full)).size;
      }
    } catch {
      // Vanished mid-sweep — ignore.
    }
  }
  return total;
}

/** Removes one dir, accounting freed bytes and recording it. Never throws. */
async function removeDir(
  full: string,
  label: string,
  result: SweepTranscodeDirResult,
  log?: FastifyBaseLogger,
): Promise<void> {
  const bytes = await dirSize(full);
  try {
    await rm(full, { recursive: true, force: true });
    result.removed.push(label);
    result.freedBytes += bytes;
    log?.debug({ path: full }, 'transcode-cleanup: removed stale scratch dir');
  } catch (err) {
    log?.warn({ err, path: full }, 'transcode-cleanup: failed to remove scratch dir');
  }
}

/**
 * Sweeps the transcode scratch dir, removing session dirs and subtitle cache
 * entries older than `maxAgeMs`. Returns a summary; a missing transcodeDir
 * yields an empty result. Individual failures are logged and skipped — the
 * sweep always completes.
 */
export async function sweepTranscodeDir(
  options: SweepTranscodeDirOptions,
): Promise<SweepTranscodeDirResult> {
  const now = options.now ?? Date.now();
  const isLive = options.isLive ?? (() => false);
  const result: SweepTranscodeDirResult = { removed: [], freedBytes: 0, kept: 0 };

  let entries: Dirent[];
  try {
    entries = await readdir(options.transcodeDir, { withFileTypes: true });
  } catch {
    return result; // no transcode dir yet
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(options.transcodeDir, entry.name);

    // The subtitle cache is a subtree keyed by media-file id; descend one level
    // and age-check each per-file cache dir independently.
    if (entry.name === SUBTITLE_SUBDIR) {
      let subEntries: Dirent[];
      try {
        subEntries = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const subFull = path.join(full, sub.name);
        if (now - (await newestMtimeMs(subFull)) < options.maxAgeMs) {
          result.kept += 1;
          continue;
        }
        await removeDir(subFull, path.join(SUBTITLE_SUBDIR, sub.name), result, options.log);
      }
      continue;
    }

    // HLS session dir (or an unknown stray dir): protect live sessions, keep
    // fresh ones, remove the rest.
    if (isLive(entry.name)) {
      result.kept += 1;
      continue;
    }
    if (now - (await newestMtimeMs(full)) < options.maxAgeMs) {
      result.kept += 1;
      continue;
    }
    await removeDir(full, entry.name, result, options.log);
  }

  return result;
}
