import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// scanLibrary is mocked with a never-resolving promise so the one test that
// exercises the real scan-manager (already-scanning guard) can hold a library
// "scanning" without ffprobe. Every other test injects its own scan trigger,
// so this mock is otherwise inert. vitest hoists vi.mock above the imports.
vi.mock('./scan.js', () => ({
  scanLibrary: vi.fn(() => new Promise(() => {})),
}));

import { disconnectPrisma, getPrisma } from '../db/client.js';
import { LibraryWatcher, type WatchHandle, type WatcherFactory } from './library-watcher.js';
import { scanLibrary } from './scan.js';
import { isScanning, resetScanStatesForTests, startScan } from './scan-manager.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string; // canonical temp dir
let mediaRoot: string;
let moviesRoot: string;
let tvRoot: string;
let prisma: PrismaClient;
let moviesLibraryId: string;
let tvLibraryId: string;

const openWatchers: LibraryWatcher[] = [];

/** Constructs a watcher and registers it for teardown after the test. */
function track(watcher: LibraryWatcher): LibraryWatcher {
  openWatchers.push(watcher);
  return watcher;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A stand-in chokidar watcher whose events tests emit synchronously. */
class FakeWatcher {
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  closed = false;

  constructor(readonly paths: string[]) {}

  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    return Promise.resolve();
  }
}

function fakeFactory(): {
  factory: WatcherFactory;
  created: FakeWatcher[];
  find: (watchedPath: string) => FakeWatcher | undefined;
} {
  const created: FakeWatcher[] = [];
  const factory: WatcherFactory = (paths) => {
    const watcher = new FakeWatcher([...paths]);
    created.push(watcher);
    return watcher as unknown as WatchHandle;
  };
  const find = (watchedPath: string): FakeWatcher | undefined =>
    created.find((watcher) => watcher.paths.includes(watchedPath));
  return { factory, created, find };
}

function fakeLogger(): { log: FastifyBaseLogger; error: ReturnType<typeof vi.fn> } {
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

async function createLibrary(name: string, type: string, roots: string[]): Promise<string> {
  const library = await prisma.library.create({
    data: { name, type, paths: { create: roots.map((root) => ({ path: root })) } },
  });
  return library.id;
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-watch-test-')));
  mediaRoot = path.join(tempDir, 'media');
  moviesRoot = path.join(mediaRoot, 'movies');
  tvRoot = path.join(mediaRoot, 'tv');
  await mkdir(moviesRoot, { recursive: true });
  await mkdir(tvRoot, { recursive: true });

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();

  moviesLibraryId = await createLibrary('Movies', 'movies', [moviesRoot]);
  tvLibraryId = await createLibrary('TV Shows', 'tv', [tvRoot]);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const watcher of openWatchers.splice(0)) await watcher.stop();
  resetScanStatesForTests();
  vi.mocked(scanLibrary).mockClear();
});

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('LibraryWatcher (injected fake chokidar)', () => {
  it('builds one watcher per configured library on start', async () => {
    const { factory } = fakeFactory();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        scan: vi.fn(),
        prisma,
        watcherFactory: factory,
      }),
    );
    await watcher.start();
    expect(watcher.watchedLibraryCount).toBe(2);
  });

  it('coalesces a burst of events under one library into a single scan', async () => {
    const { factory, find } = fakeFactory();
    const scan = vi.fn();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 1000,
        scan,
        prisma,
        watcherFactory: factory,
      }),
    );
    await watcher.start();

    vi.useFakeTimers();
    const movies = find(moviesRoot);
    movies?.emit('add', path.join(moviesRoot, 'a.mkv'));
    movies?.emit('add', path.join(moviesRoot, 'b.mkv'));
    movies?.emit('change', path.join(moviesRoot, 'a.mkv'));

    expect(scan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(scan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(moviesLibraryId);
  });

  it('triggers independent scans for events under different libraries', async () => {
    const { factory, find } = fakeFactory();
    const scan = vi.fn();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 500,
        scan,
        prisma,
        watcherFactory: factory,
      }),
    );
    await watcher.start();

    vi.useFakeTimers();
    find(moviesRoot)?.emit('add', path.join(moviesRoot, 'm.mkv'));
    find(tvRoot)?.emit('unlink', path.join(tvRoot, 'gone.mkv'));
    vi.advanceTimersByTime(500);

    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenCalledWith(moviesLibraryId);
    expect(scan).toHaveBeenCalledWith(tvLibraryId);
  });

  it('triggers a scan on an unlink event', async () => {
    const { factory, find } = fakeFactory();
    const scan = vi.fn();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 300,
        scan,
        prisma,
        watcherFactory: factory,
      }),
    );
    await watcher.start();

    vi.useFakeTimers();
    find(moviesRoot)?.emit('unlink', path.join(moviesRoot, 'deleted.mkv'));
    vi.advanceTimersByTime(300);
    expect(scan).toHaveBeenCalledExactlyOnceWith(moviesLibraryId);
  });

  it('refresh() starts watching a new library and stops watching a removed one', async () => {
    const { factory, find } = fakeFactory();
    const scan = vi.fn();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 500,
        scan,
        prisma,
        watcherFactory: factory,
      }),
    );
    await watcher.start();
    expect(watcher.watchedLibraryCount).toBe(2);

    // A new library appears on disk and in the DB.
    const animeRoot = path.join(mediaRoot, 'anime');
    await mkdir(animeRoot, { recursive: true });
    const animeId = await createLibrary('Anime', 'anime', [animeRoot]);

    await watcher.refresh();
    expect(watcher.watchedLibraryCount).toBe(3);
    const animeWatcher = find(animeRoot);
    expect(animeWatcher).toBeDefined();

    // Events on the newly-watched library trigger its scan.
    vi.useFakeTimers();
    animeWatcher?.emit('add', path.join(animeRoot, 'ep01.mkv'));
    vi.advanceTimersByTime(500);
    expect(scan).toHaveBeenCalledWith(animeId);
    vi.useRealTimers();

    // The library is removed; refresh() closes and drops its watcher.
    await prisma.library.delete({ where: { id: animeId } });
    await watcher.refresh();
    expect(watcher.watchedLibraryCount).toBe(2);
    expect(animeWatcher?.closed).toBe(true);
  });

  it('does not double-trigger a library that is already scanning', async () => {
    const scanLibraryMock = vi.mocked(scanLibrary);
    resetScanStatesForTests();
    expect(startScan(moviesLibraryId, { mediaRoots: [mediaRoot] })).toBe(true);
    expect(isScanning(moviesLibraryId)).toBe(true);
    scanLibraryMock.mockClear(); // forget the pre-started scan

    // No scan injected: the default trigger routes through the scan-manager.
    const { factory, find } = fakeFactory();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 200,
        prisma,
        watcherFactory: factory,
      }),
    );
    await watcher.start();

    vi.useFakeTimers();
    find(moviesRoot)?.emit('add', path.join(moviesRoot, 'a.mkv'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();

    // startScan no-ops because a scan is already running for this library.
    expect(scanLibraryMock).not.toHaveBeenCalled();
  });

  it('stop() closes watchers and pending debounce timers fire no scans', async () => {
    const { factory, find, created } = fakeFactory();
    const scan = vi.fn();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 1000,
        scan,
        prisma,
        watcherFactory: factory,
      }),
    );
    await watcher.start();

    vi.useFakeTimers();
    find(moviesRoot)?.emit('add', path.join(moviesRoot, 'a.mkv'));
    await watcher.stop();

    expect(created.every((c) => c.closed)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(scan).not.toHaveBeenCalled();
  });

  it('logs a watch error without throwing', async () => {
    const { factory, find } = fakeFactory();
    const { log, error } = fakeLogger();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 500,
        scan: vi.fn(),
        prisma,
        watcherFactory: factory,
        log,
      }),
    );
    await watcher.start();

    const movies = find(moviesRoot);
    expect(() => movies?.emit('error', new Error('inotify overflow'))).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
});

describe('LibraryWatcher (real chokidar)', () => {
  it('fires a debounced scan for real filesystem changes and ignores outside paths', async () => {
    const scan = vi.fn();
    const watcher = track(
      new LibraryWatcher({
        mediaRoots: [mediaRoot],
        debounceMs: 200,
        stabilityThresholdMs: 50,
        scan,
        prisma,
      }),
    );
    await watcher.start();
    // Let chokidar finish its initial (ignored) walk and become ready.
    await delay(600);

    // Several files created quickly under Movies should coalesce to one scan.
    await writeFile(path.join(moviesRoot, 'real-a.mkv'), 'video-bytes');
    await writeFile(path.join(moviesRoot, 'real-b.mkv'), 'video-bytes');

    await vi.waitFor(() => expect(scan).toHaveBeenCalledWith(moviesLibraryId), {
      timeout: 6000,
      interval: 50,
    });

    // Give any straggler event time to arrive, then assert it was coalesced.
    await delay(400);
    const moviesCalls = scan.mock.calls.filter((call) => call[0] === moviesLibraryId).length;
    expect(moviesCalls).toBe(1);

    // A file outside every watched library path triggers nothing.
    const outsideDir = path.join(tempDir, 'outside');
    await mkdir(outsideDir, { recursive: true });
    scan.mockClear();
    await writeFile(path.join(outsideDir, 'nope.mkv'), 'video-bytes');
    await delay(600);
    expect(scan).not.toHaveBeenCalled();
  }, 15_000);
});
