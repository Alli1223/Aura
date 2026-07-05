import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma } from '../db/client.js';

// Verifies the published OpenAPI spec (/api/docs/json) and that the Swagger UI
// (/api/docs) is reachable with a narrowly relaxed CSP.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-openapi-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  app = buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components?: { securitySchemes?: Record<string, unknown> };
}

describe('GET /api/docs/json', () => {
  it('serves a valid OpenAPI document listing known paths', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/docs/json' });
    expect(response.statusCode).toBe(200);

    const doc = response.json<OpenApiDoc>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('Aura API');
    expect(doc.info.version).toBeTruthy();

    const paths = Object.keys(doc.paths);
    // A representative sample of routes registered across the app.
    expect(paths).toContain('/api/health');
    expect(paths).toContain('/api/auth/login');
    // The plugin-root route is documented with its prefix's trailing slash.
    expect(paths).toContain('/api/api-tokens/');
    expect(paths).toContain('/api/api-tokens/{id}');

    // The token auth schemes are documented.
    expect(doc.components?.securitySchemes).toHaveProperty('bearerAuth');
    expect(doc.components?.securitySchemes).toHaveProperty('apiToken');
  });
});

describe('GET /api/docs (Swagger UI)', () => {
  it('is reachable and serves HTML', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/docs/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body.toLowerCase()).toContain('swagger');
  });

  it('applies a docs-scoped CSP without weakening the global policy', async () => {
    const docs = await app.inject({ method: 'GET', url: '/api/docs/' });
    const docsCsp = docs.headers['content-security-policy'];
    expect(typeof docsCsp).toBe('string');
    // Docs CSP allows data: fonts/images for the bundled UI...
    expect(docsCsp).toContain("font-src 'self' data:");
    // ...but never opens up scripts.
    expect(docsCsp).not.toContain('unsafe-eval');
    expect(docsCsp).toContain("script-src 'self'");

    // A normal route keeps the strict global CSP (no data: font allowance).
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.headers['content-security-policy']).not.toContain("font-src 'self' data:");
  });
});
