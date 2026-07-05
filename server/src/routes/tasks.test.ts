import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { setActiveTaskRunner, TaskRunner } from '../tasks/task-runner.js';

// Integration tests for the admin task status/trigger API. A TaskRunner with
// injected fake tasks is installed as the active runner so no real maintenance
// work runs; a "long" task backed by a deferred stays running to exercise 409.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let runner: TaskRunner;
let releaseLong: (() => void) | undefined;

interface Session {
  id: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

let admin: Session;
let user: Session;

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

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-tasks-routes-test-')));
  const mediaRoot = path.join(tempDir, 'media');
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

  runner = new TaskRunner();
  runner.register({
    id: 'fast',
    name: 'Fast task',
    intervalMs: 0,
    enabled: false,
    run: () => Promise.resolve({ ok: true }),
  });
  runner.register({
    id: 'long',
    name: 'Long task',
    intervalMs: 0,
    enabled: false,
    run: () => new Promise<void>((resolve) => (releaseLong = resolve)),
  });
  setActiveTaskRunner(runner);
}, 120_000);

afterAll(async () => {
  releaseLong?.();
  setActiveTaskRunner(null);
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('GET /api/tasks', () => {
  it('rejects unauthenticated (401) and non-admin (403) callers', async () => {
    expect((await api('GET', '/api/tasks')).statusCode).toBe(401);
    const forbidden = await api('GET', '/api/tasks', user.accessToken);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it('lists every registered task for an admin', async () => {
    const response = await api('GET', '/api/tasks', admin.accessToken);
    expect(response.statusCode).toBe(200);
    const { tasks } = response.json<{ tasks: Array<{ id: string; state: string }> }>();
    expect(tasks.map((t) => t.id).sort()).toEqual(['fast', 'long']);
    expect(tasks.every((t) => t.state === 'idle' || t.state === 'running')).toBe(true);
  });
});

describe('POST /api/tasks/:id/run', () => {
  it('rejects unauthenticated (401) and non-admin (403) callers', async () => {
    expect((await api('POST', '/api/tasks/fast/run')).statusCode).toBe(401);
    const forbidden = await api('POST', '/api/tasks/fast/run', user.accessToken);
    expect(forbidden.statusCode).toBe(403);
  });

  it('returns 404 for an unknown task', async () => {
    const response = await api('POST', '/api/tasks/does-not-exist/run', admin.accessToken);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('triggers a task (202) and writes an audit row', async () => {
    const response = await api('POST', '/api/tasks/fast/run', admin.accessToken);
    expect(response.statusCode).toBe(202);
    expect(response.json<{ started: boolean; taskId: string }>()).toEqual({
      started: true,
      taskId: 'fast',
    });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'task.triggered', targetId: 'fast' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(admin.id);
  });

  it('returns 409 while a task is already running', async () => {
    const first = await api('POST', '/api/tasks/long/run', admin.accessToken);
    expect(first.statusCode).toBe(202);

    const conflict = await api('POST', '/api/tasks/long/run', admin.accessToken);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<ErrorBody>().error.code).toBe('TASK_RUNNING');

    // Release the long task so it does not leak into afterAll.
    releaseLong?.();
    await vi.waitFor(() => {
      expect(runner.getStatus('long')?.state).toBe('idle');
    });
  });
});
