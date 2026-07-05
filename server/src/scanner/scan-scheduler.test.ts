import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

// scanLibrary is mocked with a never-resolving promise so that a library
// started via the real scan-manager stays "scanning" for the duration of a
// test — this lets us assert the scheduler's skip-already-scanning behaviour
// without ffprobe or a database. vitest hoists vi.mock above these imports.
vi.mock('./scan.js', () => ({
  scanLibrary: vi.fn(() => new Promise(() => {})),
}));

import { scanLibrary } from './scan.js';
import { isScanning, resetScanStatesForTests, startScan } from './scan-manager.js';
import { ScanScheduler, scanAllLibraries } from './scan-scheduler.js';

function fakeLogger(): {
  log: FastifyBaseLogger;
  error: ReturnType<typeof vi.fn>;
} {
  const error = vi.fn();
  const noop = vi.fn();
  const log = {
    error,
    warn: noop,
    info: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => log,
  } as unknown as FastifyBaseLogger;
  return { log, error };
}

/** Prisma stub whose library.findMany returns the given ids. */
function fakePrisma(ids: string[]): PrismaClient {
  return {
    library: { findMany: vi.fn(() => Promise.resolve(ids.map((id) => ({ id })))) },
  } as unknown as PrismaClient;
}

afterEach(() => {
  vi.useRealTimers();
  resetScanStatesForTests();
  vi.mocked(scanLibrary).mockClear();
});

describe('ScanScheduler', () => {
  it('fires the rescan at each interval and stop() halts further fires', async () => {
    vi.useFakeTimers();
    const scanAll = vi.fn();
    const scheduler = new ScanScheduler({ intervalMs: 1000, scanAll });

    scheduler.start();
    expect(scheduler.running).toBe(true);
    expect(scanAll).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(scanAll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(scanAll).toHaveBeenCalledTimes(3);

    scheduler.stop();
    expect(scheduler.running).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(scanAll).toHaveBeenCalledTimes(3);
  });

  it('is disabled (never fires) when the interval is 0', async () => {
    vi.useFakeTimers();
    const scanAll = vi.fn();
    const scheduler = new ScanScheduler({ intervalMs: 0, scanAll });

    scheduler.start();
    expect(scheduler.running).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(scanAll).not.toHaveBeenCalled();
  });

  it('logs (never throws) when the rescan action fails', async () => {
    vi.useFakeTimers();
    const { log, error } = fakeLogger();
    const scanAll = vi.fn(() => {
      throw new Error('boom');
    });
    const scheduler = new ScanScheduler({ intervalMs: 1000, scanAll, log });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(scanAll).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    scheduler.stop();
  });
});

describe('scanAllLibraries', () => {
  it('triggers a scan for every library', async () => {
    const scan = vi.fn();
    await scanAllLibraries({ prisma: fakePrisma(['x', 'y', 'z']), scan });
    expect(scan.mock.calls.map((call) => call[0])).toEqual(['x', 'y', 'z']);
  });

  it('skips libraries that are already scanning', async () => {
    const scanLibraryMock = vi.mocked(scanLibrary);
    resetScanStatesForTests();
    expect(startScan('lib-a')).toBe(true);
    expect(isScanning('lib-a')).toBe(true);
    scanLibraryMock.mockClear(); // forget the pre-started scan

    // Default per-library trigger routes through the scan-manager's startScan.
    await scanAllLibraries({ prisma: fakePrisma(['lib-a', 'lib-b']) });

    const scanned = scanLibraryMock.mock.calls.map((call) => call[0]);
    expect(scanned).toEqual(['lib-b']); // lib-a skipped, lib-b started
  });

  it('logs (never throws) when the library list cannot be loaded', async () => {
    const { log, error } = fakeLogger();
    const badPrisma = {
      library: { findMany: vi.fn(() => Promise.reject(new Error('db down'))) },
    } as unknown as PrismaClient;

    await expect(scanAllLibraries({ prisma: badPrisma, log })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
