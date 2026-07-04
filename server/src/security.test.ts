import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { disconnectPrisma } from './db/client.js';

// Integration tests for the server hardening: secure headers, CORS, error
// hygiene, request ids and log redaction. Uses a real temporary SQLite
// database so auth routes can be exercised end-to-end.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface ErrorBody {
  error: { code: string; message: string };
}

let tempDir: string;
let webDist: string;
const indexHtml = '<!doctype html><html><head><title>Aura</title></head></html>';

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-security-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');

  webDist = path.join(tempDir, 'web-dist');
  await mkdir(webDist);
  await writeFile(path.join(webDist, 'index.html'), indexHtml);
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.CORS_ORIGINS;
});

describe('secure headers', () => {
  const expectSecureHeaders = (headers: Record<string, unknown>): void => {
    const csp = String(headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // COEP must stay off: it breaks media playback.
    expect(headers['cross-origin-embedder-policy']).toBeUndefined();
  };

  it('are present on API responses', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expectSecureHeaders(response.headers);
  });

  it('are present on the SPA fallback response', async () => {
    app = buildApp({}, { webDistDir: webDist });

    const response = await app.inject({ method: 'GET', url: '/library/movies/42' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(indexHtml);
    expectSecureHeaders(response.headers);
  });

  it('are present on static file responses', async () => {
    app = buildApp({}, { webDistDir: webDist });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expectSecureHeaders(response.headers);
  });
});

describe('CORS', () => {
  it('denies cross-origin requests by default (no ACAO header)', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('allows configured origins with credentials', async () => {
    process.env.CORS_ORIGINS = 'https://app.example.com';
    app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://app.example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers preflight requests for configured origins', async () => {
    process.env.CORS_ORIGINS = 'https://app.example.com';
    app = buildApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('sends no ACAO header to origins outside the configured list', async () => {
    process.env.CORS_ORIGINS = 'https://app.example.com';
    app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error hygiene', () => {
  it('500 responses carry a generic message and never leak details or stacks', async () => {
    app = buildApp();
    app.get('/api/boom', () => {
      throw new Error('sensitive-internal-details');
    });

    const response = await app.inject({ method: 'GET', url: '/api/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>()).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    expect(response.body).not.toContain('sensitive-internal-details');
    expect(response.body).not.toContain('stack');
  });

  it('rejects request bodies above the 1 MiB limit with the standard shape', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: `{"username":"someone","password":"${'x'.repeat(1024 * 1024)}"}`,
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(413);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
    expect(body.error.message).toBeTruthy();
  });
});

describe('request ids', () => {
  it('generates an x-request-id response header', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates an incoming x-request-id header', async () => {
    app = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'proxy-supplied-id-1' },
    });

    expect(response.headers['x-request-id']).toBe('proxy-supplied-id-1');
  });
});

describe('log redaction', () => {
  it('never writes credentials or auth headers from a login request to the logs', async () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    app = buildApp({ logger: { stream, level: 'info' } });

    const password = 'hunter2-super-secret';
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'redaction.user', password },
    });
    expect(registered.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'redaction.user', password },
      headers: {
        authorization: 'Bearer super-secret-access-token',
        cookie: 'aura_refresh=super-secret-cookie-value',
      },
    });
    expect(login.statusCode).toBe(200);
    const refreshToken = login.cookies.find((c) => c.name === 'aura_refresh')?.value;

    const output = lines.join('');
    expect(output.length).toBeGreaterThan(0); // requests were actually logged
    expect(output).not.toContain(password);
    expect(output).not.toContain('super-secret-access-token');
    expect(output).not.toContain('super-secret-cookie-value');
    if (refreshToken !== undefined) {
      expect(output).not.toContain(refreshToken);
    }
  });

  it('redacts secret fields in structured log calls', async () => {
    const lines: string[] = [];
    const stream = { write: (chunk: string) => void lines.push(chunk) };
    app = buildApp({ logger: { stream, level: 'info' } });

    app.log.info({
      body: { password: 'plaintext-password' },
      credentials: { password: 'nested-password' },
    });

    const output = lines.join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('plaintext-password');
    expect(output).not.toContain('nested-password');
  });
});
