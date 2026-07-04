import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { disconnectPrisma } from './db/client.js';

// Rate limiting is disabled by default under NODE_ENV=test so the other
// suites can hammer the API; these tests re-enable it explicitly with tiny
// budgets. Each test builds a fresh app so limiter counters start at zero.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GLOBAL_MAX = 6;
const AUTH_MAX = 3;
const REFRESH_MAX = 4;

interface ErrorBody {
  error: { code: string; message: string };
}

let tempDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-ratelimit-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  process.env.RATE_LIMIT_ENABLED = 'true';
  process.env.RATE_LIMIT_MAX = String(GLOBAL_MAX);
  process.env.RATE_LIMIT_AUTH_MAX = String(AUTH_MAX);
  process.env.RATE_LIMIT_REFRESH_MAX = String(REFRESH_MAX);
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

afterEach(async () => {
  await app.close();
  process.env.RATE_LIMIT_ENABLED = 'true';
});

function login(): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'nobody-here', password: 'not-the-password' },
  });
}

function register(): Promise<LightMyRequestResponse> {
  // Invalid payload on purpose: a 400 still consumes rate limit budget and
  // avoids creating users.
  return app.inject({ method: 'POST', url: '/api/auth/register', payload: {} });
}

function refresh(): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/api/auth/refresh' });
}

function health(): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/api/health' });
}

describe('rate limiting', () => {
  it('returns 429 with the standard error shape after exceeding the login limit', async () => {
    app = buildApp();

    for (let i = 0; i < AUTH_MAX; i++) {
      expect((await login()).statusCode).toBe(401);
    }

    const limited = await login();
    expect(limited.statusCode).toBe(429);
    const body = limited.json<ErrorBody>();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toContain('Rate limit exceeded');
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['x-ratelimit-limit']).toBe(String(AUTH_MAX));
    // Hardening headers still apply to throttled responses.
    expect(limited.headers['x-request-id']).toBeTruthy();

    // The login limit is per-route: other endpoints are still served.
    expect((await health()).statusCode).toBe(200);
  });

  it('limits register with the same strict budget, counted separately', async () => {
    app = buildApp();

    // Exhaust the login bucket first: register must have its own counter.
    for (let i = 0; i <= AUTH_MAX; i++) await login();

    for (let i = 0; i < AUTH_MAX; i++) {
      expect((await register()).statusCode).toBe(400);
    }
    const limited = await register();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ErrorBody>().error.code).toBe('RATE_LIMITED');
  });

  it('gives refresh its own, less strict budget than login/register', async () => {
    expect(REFRESH_MAX).toBeGreaterThan(AUTH_MAX);
    app = buildApp();

    // Exhaust the stricter login bucket; refresh must still accept requests.
    for (let i = 0; i <= AUTH_MAX; i++) await login();
    expect((await login()).statusCode).toBe(429);

    for (let i = 0; i < REFRESH_MAX; i++) {
      // 401: no refresh cookie. The request still consumed refresh budget.
      expect((await refresh()).statusCode).toBe(401);
    }
    const limited = await refresh();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ErrorBody>().error.code).toBe('RATE_LIMITED');
  });

  it('applies the global limit to routes without an override', async () => {
    app = buildApp();

    for (let i = 0; i < GLOBAL_MAX; i++) {
      expect((await health()).statusCode).toBe(200);
    }

    const limited = await health();
    expect(limited.statusCode).toBe(429);
    const body = limited.json<ErrorBody>();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['x-ratelimit-limit']).toBe(String(GLOBAL_MAX));
  });

  it('is disabled by default under NODE_ENV=test so suites can hammer the API', async () => {
    delete process.env.RATE_LIMIT_ENABLED;
    app = buildApp();

    for (let i = 0; i < GLOBAL_MAX + AUTH_MAX + 5; i++) {
      expect((await login()).statusCode).toBe(401);
    }
    expect((await health()).statusCode).toBe(200);
  });
});
