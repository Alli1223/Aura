import { afterEach, describe, expect, it, vi } from 'vitest';

import { getScanState, isScanning, resetScanStatesForTests, startScan } from './scan-manager.js';
import type { ScanStats } from './scan.js';

// Unit tests for the in-memory scan-state machine. scanLibrary is mocked with
// a controllable deferred so we can observe the idle -> scanning -> idle
// transitions, the already-running guard and error capture without touching
// the filesystem or the database. vitest hoists vi.mock above these imports.

const control = vi.hoisted(() => {
  const deferreds: Array<{
    resolve: (stats: unknown) => void;
    reject: (err: unknown) => void;
  }> = [];
  const progressFns: Array<(stats: unknown) => void> = [];
  return {
    deferreds,
    progressFns,
    calls: [] as string[],
    reset(): void {
      deferreds.length = 0;
      progressFns.length = 0;
      control.calls.length = 0;
    },
  };
});

vi.mock('./scan.js', () => ({
  scanLibrary: vi.fn((libraryId: string, opts?: { onProgress?: (stats: unknown) => void }) => {
    control.calls.push(libraryId);
    if (opts?.onProgress !== undefined) control.progressFns.push(opts.onProgress);
    return new Promise((resolve, reject) => {
      control.deferreds.push({ resolve, reject });
    });
  }),
}));

function fakeStats(overrides: Partial<ScanStats> = {}): ScanStats {
  return {
    filesSeen: 5,
    filesAdded: 3,
    filesUpdated: 0,
    filesUnchanged: 2,
    filesMissing: 0,
    filesSkipped: 0,
    itemsCreated: 4,
    errors: [],
    ...overrides,
  };
}

afterEach(() => {
  // Drain any still-pending scan so it cannot leak into the next test.
  for (const deferred of control.deferreds) deferred.resolve(fakeStats());
  control.reset();
  resetScanStatesForTests();
});

describe('scan-manager', () => {
  it('reports idle for a library that has never been scanned', () => {
    const state = getScanState('never');
    expect(state).toMatchObject({
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      stats: null,
      error: null,
    });
  });

  it('transitions idle -> scanning -> idle with the final stats', async () => {
    expect(startScan('lib-1')).toBe(true);
    expect(control.calls).toEqual(['lib-1']);

    const scanning = getScanState('lib-1');
    expect(scanning.status).toBe('scanning');
    expect(scanning.startedAt).toBeInstanceOf(Date);
    expect(scanning.finishedAt).toBeNull();
    expect(isScanning('lib-1')).toBe(true);

    const result = fakeStats({ filesAdded: 7 });
    control.deferreds[0]?.resolve(result);

    await vi.waitFor(() => expect(getScanState('lib-1').status).toBe('idle'));
    const done = getScanState('lib-1');
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.stats).toEqual(result);
    expect(done.error).toBeNull();
    expect(isScanning('lib-1')).toBe(false);
  });

  it('refuses a second scan while one is running (starts nothing new)', () => {
    expect(startScan('lib-2')).toBe(true);
    expect(startScan('lib-2')).toBe(false);
    expect(control.calls).toEqual(['lib-2']); // scanLibrary called exactly once
    expect(isScanning('lib-2')).toBe(true);
  });

  it('allows a fresh scan once the previous one has finished', async () => {
    expect(startScan('lib-3')).toBe(true);
    control.deferreds[0]?.resolve(fakeStats());
    await vi.waitFor(() => expect(getScanState('lib-3').status).toBe('idle'));

    expect(startScan('lib-3')).toBe(true);
    expect(control.calls).toEqual(['lib-3', 'lib-3']);
  });

  it('reflects live progress counters while scanning', () => {
    startScan('lib-4');
    const midway = fakeStats({ filesSeen: 100, filesAdded: 40 });
    control.progressFns[0]?.(midway);
    expect(getScanState('lib-4').stats).toEqual(midway);
    expect(getScanState('lib-4').status).toBe('scanning');
  });

  it('captures a whole-scan failure into the state error and returns to idle', async () => {
    startScan('lib-5');
    control.deferreds[0]?.reject(new Error('root exploded'));

    await vi.waitFor(() => expect(getScanState('lib-5').status).toBe('idle'));
    const state = getScanState('lib-5');
    expect(state.error).toBe('root exploded');
    expect(state.finishedAt).toBeInstanceOf(Date);
  });
});
