import { scanLibrary, type ScanOptions, type ScanStats } from './scan.js';

// In-memory scan-state tracking, one slot per library. Scans run as
// fire-and-forget promises started by startScan; the state object is
// mutated live (progress counters via onProgress, terminal status/stats/
// error on settle) so the status endpoint always reads current numbers.
//
// State is process-local by design: a restart forgets running scans, which
// is correct — the scan died with the process and can simply be started
// again (scans are idempotent).

export type ScanStatus = 'idle' | 'scanning';

export interface ScanState {
  status: ScanStatus;
  /** When the current/last scan started; null if never scanned. */
  startedAt: Date | null;
  /** When the last scan finished; null while scanning or if never scanned. */
  finishedAt: Date | null;
  /** Live counters while scanning; the final result once idle again. */
  stats: ScanStats | null;
  /** Message of a whole-scan failure (per-file errors live in stats.errors). */
  error: string | null;
}

const states = new Map<string, ScanState>();

const IDLE_STATE: Readonly<ScanState> = Object.freeze({
  status: 'idle' as const,
  startedAt: null,
  finishedAt: null,
  stats: null,
  error: null,
});

/** Current scan state for a library (a never-scanned library is idle). */
export function getScanState(libraryId: string): ScanState {
  return states.get(libraryId) ?? { ...IDLE_STATE };
}

/** True while a scan for this library is running. */
export function isScanning(libraryId: string): boolean {
  return states.get(libraryId)?.status === 'scanning';
}

/**
 * Starts an asynchronous scan for the library. Returns false (and starts
 * nothing) when a scan for this library is already running — the caller
 * turns that into a 409. Scan failures never reject anything unhandled;
 * they are captured into the state's `error`.
 */
export function startScan(libraryId: string, opts: ScanOptions = {}): boolean {
  if (isScanning(libraryId)) return false;

  const state: ScanState = {
    status: 'scanning',
    startedAt: new Date(),
    finishedAt: null,
    stats: null,
    error: null,
  };
  states.set(libraryId, state);

  void scanLibrary(libraryId, {
    ...opts,
    onProgress: (stats) => {
      state.stats = stats;
      opts.onProgress?.(stats);
    },
  })
    .then((stats) => {
      state.stats = stats;
    })
    .catch((err: unknown) => {
      state.error = err instanceof Error ? err.message : String(err);
      opts.log?.error({ libraryId, err }, 'scan: library scan failed');
    })
    .finally(() => {
      state.status = 'idle';
      state.finishedAt = new Date();
    });

  return true;
}

/** Test-only: forget all scan state (never call while scans are running). */
export function resetScanStatesForTests(): void {
  states.clear();
}
