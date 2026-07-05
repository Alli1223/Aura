import path from 'node:path';

import type { PrismaClient } from '@prisma/client';
import { watch as chokidarWatch } from 'chokidar';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import { validateLibraryPath } from '../lib/media-roots.js';
import { startScan } from './scan-manager.js';

// Filesystem watcher for near-realtime library updates. One chokidar watcher
// is built per library, covering every LibraryPath root that re-validates
// inside the configured media roots. Bursts of add/unlink/change events are
// coalesced per-library over a debounce window, then a single scan of that
// library is triggered via the scan-manager (which no-ops when a scan for the
// same library is already running). The watcher never reimplements scanning —
// it only decides *when* to scan and *which* library.
//
// Everything the class touches is injectable (scan trigger, prisma, chokidar
// factory) so it can be unit-tested with fake timers and without ffprobe, a
// database, or real filesystem watches.

/** chokidar events that indicate a library's contents changed. */
const CHANGE_EVENTS = ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const;

/** Default quiet period (ms) used to coalesce a burst of fs events. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 10_000;

/**
 * Default awaitWriteFinish stability window (ms): a file must stop changing
 * size for this long before an event fires, so a half-copied file never
 * triggers a scan mid-write.
 */
export const DEFAULT_WATCH_STABILITY_MS = 2_000;

/** Triggers a scan of one library. The default routes through the scan-manager. */
export type ScanTrigger = (libraryId: string) => void;

/** The subset of a chokidar FSWatcher this module relies on. */
export interface WatchHandle {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  close(): Promise<void>;
}

/** Builds a watcher over `paths`. Injectable so tests avoid real chokidar. */
export type WatcherFactory = (paths: string[]) => WatchHandle;

export interface LibraryWatcherOptions {
  /** Media roots that every watched library path must re-validate inside. */
  mediaRoots: readonly string[];
  /** Quiet period (ms) coalescing a burst of events. Default 10s. */
  debounceMs?: number;
  /** awaitWriteFinish stability window (ms). Default 2s. */
  stabilityThresholdMs?: number;
  /** Scan trigger; defaults to the scan-manager's startScan (skips 409s). */
  scan?: ScanTrigger;
  log?: FastifyBaseLogger;
  /** Prisma client; defaults to the shared singleton. */
  prisma?: PrismaClient;
  /** chokidar factory; defaults to a real chokidar watcher. */
  watcherFactory?: WatcherFactory;
}

/**
 * Watches every configured library's paths and triggers debounced per-library
 * scans when their contents change on disk.
 */
export class LibraryWatcher {
  private readonly mediaRoots: readonly string[];
  private readonly debounceMs: number;
  private readonly stabilityMs: number;
  private readonly scan: ScanTrigger;
  private readonly log?: FastifyBaseLogger;
  private readonly prisma: PrismaClient;
  private readonly factory: WatcherFactory;

  /** libraryId -> its live watcher. */
  private readonly watchers = new Map<string, WatchHandle>();
  /** libraryId -> a stable key of the paths it watches (change detection). */
  private readonly watchedKeys = new Map<string, string>();
  /** libraryId -> pending debounce timer. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private started = false;
  private stopped = false;

  constructor(opts: LibraryWatcherOptions) {
    this.mediaRoots = opts.mediaRoots;
    this.debounceMs = opts.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.stabilityMs = opts.stabilityThresholdMs ?? DEFAULT_WATCH_STABILITY_MS;
    this.log = opts.log;
    this.prisma = opts.prisma ?? getPrisma();
    this.scan =
      opts.scan ??
      ((libraryId) => {
        startScan(libraryId, { mediaRoots: this.mediaRoots, log: this.log });
      });
    this.factory =
      opts.watcherFactory ?? ((paths) => createChokidarWatcher(paths, this.stabilityMs));
  }

  /** Number of libraries currently watched (test/introspection aid). */
  get watchedLibraryCount(): number {
    return this.watchers.size;
  }

  /** Builds watchers for every current library. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    await this.syncWatchers();
  }

  /**
   * Re-reads the libraries and reconciles watchers: adds one for a new
   * library, drops one for a removed library, and rebuilds one whose paths
   * changed. Call after library CRUD. No-op once stopped.
   */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    await this.syncWatchers();
  }

  /** Closes every watcher, clears pending debounce timers, and stops scanning. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const closing = [...this.watchers.values()].map((watcher) => this.closeQuiet(watcher));
    this.watchers.clear();
    this.watchedKeys.clear();
    await Promise.all(closing);
  }

  /** Reconciles the live watcher set against the libraries currently in the DB. */
  private async syncWatchers(): Promise<void> {
    const desired = await this.loadLibraryPaths();

    // Drop watchers for libraries that vanished or whose paths changed.
    for (const libraryId of [...this.watchers.keys()]) {
      const paths = desired.get(libraryId);
      const key = paths === undefined ? undefined : pathsKey(paths);
      if (key === undefined || key !== this.watchedKeys.get(libraryId)) {
        await this.removeWatcher(libraryId);
      }
    }

    // Add watchers for libraries that are newly present or were just dropped
    // because their paths changed.
    for (const [libraryId, paths] of desired) {
      if (paths.length === 0 || this.watchers.has(libraryId)) continue;
      this.createWatcher(libraryId, paths);
    }
  }

  /**
   * Loads every library with the subset of its paths that still re-validates
   * inside the media roots (canonical form). A DB failure yields an empty map
   * so a broken database can never crash the watcher.
   */
  private async loadLibraryPaths(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    let libraries;
    try {
      libraries = await this.prisma.library.findMany({ include: { paths: true } });
    } catch (err) {
      this.log?.error({ err }, 'library-watcher: failed to load libraries');
      return result;
    }

    for (const library of libraries) {
      const valid = new Set<string>();
      for (const entry of library.paths) {
        try {
          valid.add(await validateLibraryPath(entry.path, this.mediaRoots));
        } catch (err) {
          this.log?.warn(
            { libraryId: library.id, path: entry.path, reason: message(err) },
            'library-watcher: skipping invalid library path',
          );
        }
      }
      result.set(library.id, [...valid]);
    }
    return result;
  }

  private createWatcher(libraryId: string, paths: string[]): void {
    let watcher: WatchHandle;
    try {
      watcher = this.factory(paths);
    } catch (err) {
      this.log?.error({ libraryId, err }, 'library-watcher: failed to create watcher');
      return;
    }

    for (const event of CHANGE_EVENTS) {
      watcher.on(event, () => this.scheduleScan(libraryId));
    }
    // A watch error (e.g. ENOSPC on inotify) must be logged, never thrown:
    // one failing library must not take the whole watcher process down.
    watcher.on('error', (err) => {
      this.log?.error({ libraryId, err }, 'library-watcher: watch error');
    });

    this.watchers.set(libraryId, watcher);
    this.watchedKeys.set(libraryId, pathsKey(paths));
    this.log?.debug({ libraryId, paths }, 'library-watcher: watching library');
  }

  private async removeWatcher(libraryId: string): Promise<void> {
    const watcher = this.watchers.get(libraryId);
    this.watchers.delete(libraryId);
    this.watchedKeys.delete(libraryId);
    const timer = this.timers.get(libraryId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(libraryId);
    }
    if (watcher !== undefined) await this.closeQuiet(watcher);
  }

  /** (Re)arms the per-library debounce timer; the scan fires once it elapses. */
  private scheduleScan(libraryId: string): void {
    if (this.stopped) return;
    const existing = this.timers.get(libraryId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(libraryId);
      if (this.stopped) return;
      try {
        this.scan(libraryId);
      } catch (err) {
        this.log?.error({ libraryId, err }, 'library-watcher: scan trigger failed');
      }
    }, this.debounceMs);
    // A debounce timer must never keep the process alive on shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(libraryId, timer);
  }

  private async closeQuiet(watcher: WatchHandle): Promise<void> {
    try {
      await watcher.close();
    } catch (err) {
      this.log?.warn({ err }, 'library-watcher: error closing watcher');
    }
  }
}

/** Order-independent key of a library's watched paths. */
function pathsKey(paths: readonly string[]): string {
  return [...paths].sort().join(' ');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Builds a real chokidar watcher configured for library media trees. */
function createChokidarWatcher(paths: string[], stabilityMs: number): WatchHandle {
  const pollInterval = Math.max(10, Math.min(100, stabilityMs));
  const watcher = chokidarWatch(paths, {
    // Only react to changes after start; the initial tree is the scanner's job.
    ignoreInitial: true,
    // Symlinks are never followed (matches the scanner's containment model).
    followSymlinks: false,
    // Ignore dotfiles / dot-directories, exactly like the scanner walk.
    ignored: (candidate: string) => path.basename(candidate).startsWith('.'),
    // Wait for a file to stop growing so half-copied files never trigger.
    awaitWriteFinish: { stabilityThreshold: stabilityMs, pollInterval },
  });
  return watcher as unknown as WatchHandle;
}

// ---------------------------------------------------------------------------
// Process-wide accessor
// ---------------------------------------------------------------------------

// The running watcher (set by startup wiring) so that library CRUD can call
// refresh() after mutating libraries without threading the instance through
// every route.
let activeWatcher: LibraryWatcher | null = null;

/** Registers (or clears) the process-wide watcher used by refreshLibraryWatcher. */
export function setActiveLibraryWatcher(watcher: LibraryWatcher | null): void {
  activeWatcher = watcher;
}

/** The process-wide watcher, if one is running. */
export function getActiveLibraryWatcher(): LibraryWatcher | null {
  return activeWatcher;
}

/** Refreshes the process-wide watcher if one is running; otherwise a no-op. */
export async function refreshLibraryWatcher(): Promise<void> {
  await activeWatcher?.refresh();
}
