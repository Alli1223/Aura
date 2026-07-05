import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import { startScan } from './scan-manager.js';

// Periodic full-library rescan. A plain interval timer triggers a scan of
// every library at a fixed cadence, delegating the actual work (and the
// "already scanning" guard) to the scan-manager. Everything is injectable so
// the interval behaviour can be exercised with fake timers and the rescan
// action without touching ffprobe or a real database.

/** Default cadence between full rescans: 6 hours. */
export const DEFAULT_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ScanAllOptions {
  /** Media roots passed through to each library scan. */
  mediaRoots?: readonly string[];
  log?: FastifyBaseLogger;
  /** Prisma client; defaults to the shared singleton. */
  prisma?: PrismaClient;
  /** Per-library trigger; defaults to the scan-manager's startScan (skips 409s). */
  scan?: (libraryId: string) => void;
}

/**
 * Triggers a scan of every library, skipping ones already scanning (the
 * scan-manager no-ops a second concurrent scan for the same library). Never
 * throws for per-library or database reasons: a failure to list libraries is
 * logged and swallowed so the scheduler keeps ticking.
 */
export async function scanAllLibraries(opts: ScanAllOptions = {}): Promise<void> {
  const prisma = opts.prisma ?? getPrisma();
  const scan =
    opts.scan ??
    ((libraryId: string) => {
      startScan(libraryId, { mediaRoots: opts.mediaRoots, log: opts.log });
    });

  let libraries: Array<{ id: string }>;
  try {
    libraries = await prisma.library.findMany({ select: { id: true } });
  } catch (err) {
    opts.log?.error({ err }, 'scan-scheduler: failed to list libraries for periodic rescan');
    return;
  }

  for (const library of libraries) scan(library.id);
}

export interface ScanSchedulerOptions extends ScanAllOptions {
  /** Interval between full rescans in ms. Values <= 0 disable the scheduler. */
  intervalMs: number;
  /** Full-rescan action; defaults to scanAllLibraries with the shared options. */
  scanAll?: () => void | Promise<void>;
}

/** Fires a full rescan of all libraries on a fixed interval. */
export class ScanScheduler {
  private readonly intervalMs: number;
  private readonly scanAll: () => void | Promise<void>;
  private readonly log?: FastifyBaseLogger;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ScanSchedulerOptions) {
    this.intervalMs = opts.intervalMs;
    this.log = opts.log;
    this.scanAll = opts.scanAll ?? (() => scanAllLibraries(opts));
  }

  /** True while an interval is armed (a disabled scheduler is never running). */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Arms the interval. No-op when disabled (interval <= 0) or already running. */
  start(): void {
    if (this.intervalMs <= 0 || this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Periodic rescans must never keep the process alive on shutdown.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Disarms the interval; safe to call when not running. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.scanAll();
    } catch (err) {
      this.log?.error({ err }, 'scan-scheduler: periodic rescan failed');
    }
  }
}
