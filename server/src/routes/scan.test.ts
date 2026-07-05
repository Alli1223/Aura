import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScanStats } from '../scanner/scan.js';

// Integration tests for the scan trigger/status endpoints against a real
// temporary SQLite database. scanLibrary is mocked with a controllable
// deferred so a scan can be held "running" long enough to exercise the 409
// and the all-libraries skip path without depending on ffprobe timing.
// vitest hoists vi.mock above the imports below.

const control = vi.hoisted(() => {
  const pending: Array<() => void> = [];
  return {
    calls: [] as string[],
    register(resolve: () => void): void {
      pending.push(resolve);
    },
    settleAll(stats: unknown): void {
      for (const resolve of pending.splice(0)) resolve();
      control.lastStats = stats;
    },
    lastStats: undefined as unknown,
    reset(): void {
      pending.length = 0;
      control.calls.length = 0;
    },
  };
});

const FAKE_STATS: ScanStats = {
  filesSeen: 4,
  filesAdded: 2,
  filesUpdated: 0,
  filesUnchanged: 2,
  filesMissing: 0,
  filesSkipped: 0,
  itemsCreated: 3,
  errors: [],
};

vi.mock('../scanner/scan.js', () => ({
  scanLibrary: vi.fn((libraryId: string) => {
    control.calls.push(libraryId);
    return new Promise<ScanStats>((resolve) => {
      control.register(() => resolve(FAKE_STATS));
    });
  }),
}));

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { resetScanStatesForTests } from '../scanner/scan-manager.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let mediaRoot: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface Session {
  id: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

let admin: Session;
let user: Session;
let libAlpha: string;
let libBravo: string;

function api(
  method: 'GET' | 'POST',
  url: string,
  token?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function registerUser(): Promise<Session> {
  const username = `user-${randomUUID().slice(0, 18)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string }; accessToken: string }>();
  return { id: body.user.id, accessToken: body.accessToken };
}

async function createLibrary(name: string): Promise<string> {
  const dir = path.join(mediaRoot, `dir-${randomUUID().slice(0, 8)}`);
  await mkdir(dir);
  const library = await prisma.library.create({
    data: { name, type: 'movies', paths: { create: { path: dir } } },
  });
  return library.id;
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-scan-routes-test-')));
  mediaRoot = path.join(tempDir, 'media');
  await mkdir(mediaRoot);

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  process.env.MEDIA_ROOTS = mediaRoot;
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  admin = await registerUser(); // first registered user becomes admin
  user = await registerUser();
  libAlpha = await createLibrary('Alpha');
  libBravo = await createLibrary('Bravo');
}, 120_000);

afterEach(() => {
  control.settleAll(FAKE_STATS);
  control.reset();
  resetScanStatesForTests();
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('route protection', () => {
  it('rejects unauthenticated requests with 401 on every scan route', async () => {
    for (const [method, url] of [
      ['POST', `/api/libraries/${libAlpha}/scan`],
      ['GET', `/api/libraries/${libAlpha}/scan`],
      ['POST', '/api/scan'],
    ] as const) {
      const response = await api(method, url);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(control.calls).toEqual([]);
  });

  it('rejects non-admins with 403 FORBIDDEN on every scan route', async () => {
    for (const [method, url] of [
      ['POST', `/api/libraries/${libAlpha}/scan`],
      ['GET', `/api/libraries/${libAlpha}/scan`],
      ['POST', '/api/scan'],
    ] as const) {
      const response = await api(method, url, user.accessToken);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
    }
    expect(control.calls).toEqual([]);
  });

  it('returns 404 for an unknown library on both trigger and status', async () => {
    const post = await api('POST', '/api/libraries/does-not-exist/scan', admin.accessToken);
    expect(post.statusCode).toBe(404);
    expect(post.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    const get = await api('GET', '/api/libraries/does-not-exist/scan', admin.accessToken);
    expect(get.statusCode).toBe(404);
    expect(get.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(control.calls).toEqual([]);
  });
});

describe('POST /api/libraries/:id/scan', () => {
  it('starts a scan (202), rejects a concurrent one (409), then completes', async () => {
    const start = await api('POST', `/api/libraries/${libAlpha}/scan`, admin.accessToken);
    expect(start.statusCode).toBe(202);
    expect(start.json<{ started: boolean }>().started).toBe(true);
    expect(control.calls).toEqual([libAlpha]);

    // Second trigger while the first is still running.
    const conflict = await api('POST', `/api/libraries/${libAlpha}/scan`, admin.accessToken);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<ErrorBody>().error.code).toBe('SCAN_IN_PROGRESS');
    expect(control.calls).toEqual([libAlpha]); // no second scanLibrary call

    // Status reports scanning.
    const scanning = await api('GET', `/api/libraries/${libAlpha}/scan`, admin.accessToken);
    expect(scanning.json<{ scan: { status: string } }>().scan.status).toBe('scanning');

    // Audit row written for the start.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'library.scan_started', targetId: libAlpha },
    });
    expect(audit).not.toBeNull();

    // Let the scan finish and confirm the status flips to idle with stats.
    control.settleAll(FAKE_STATS);
    await vi.waitFor(async () => {
      const done = await api('GET', `/api/libraries/${libAlpha}/scan`, admin.accessToken);
      expect(done.json<{ scan: { status: string } }>().scan.status).toBe('idle');
    });
    const idle = await api('GET', `/api/libraries/${libAlpha}/scan`, admin.accessToken);
    const body = idle.json<{
      scan: { status: string; finishedAt: string | null; stats: ScanStats | null };
    }>();
    expect(body.scan.finishedAt).not.toBeNull();
    expect(body.scan.stats).toEqual(FAKE_STATS);
  });
});

describe('GET /api/libraries/:id/scan', () => {
  it('reports idle for a library that has never been scanned', async () => {
    const response = await api('GET', `/api/libraries/${libBravo}/scan`, admin.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ scan: Record<string, unknown> }>().scan).toMatchObject({
      libraryId: libBravo,
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      stats: null,
      error: null,
    });
  });
});

describe('POST /api/scan', () => {
  it('starts every idle library and skips ones already scanning', async () => {
    // Alpha is already scanning; Bravo is idle.
    const startAlpha = await api('POST', `/api/libraries/${libAlpha}/scan`, admin.accessToken);
    expect(startAlpha.statusCode).toBe(202);
    expect(control.calls).toEqual([libAlpha]);

    const all = await api('POST', '/api/scan', admin.accessToken);
    expect(all.statusCode).toBe(202);
    const results = all.json<{ libraries: Array<{ name: string; started: boolean }> }>().libraries;

    const alpha = results.find((entry) => entry.name === 'Alpha');
    const bravo = results.find((entry) => entry.name === 'Bravo');
    expect(alpha?.started).toBe(false); // already scanning -> skipped
    expect(bravo?.started).toBe(true); // idle -> started
    // Only Bravo was newly started; Alpha was not scanned a second time.
    expect(control.calls).toEqual([libAlpha, libBravo]);
  });
});
