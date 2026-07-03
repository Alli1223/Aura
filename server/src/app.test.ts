import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('buildApp', () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('GET /api/health returns 200 with status ok and a version', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; version: string }>();
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('does not serve static files when webDistDir does not exist', async () => {
    app = buildApp({}, { webDistDir: '/nonexistent/web/dist' });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  describe('static web app serving', () => {
    const indexHtml = '<!doctype html><html><head><title>Aura</title></head></html>';
    const webDist = mkdtempSync(path.join(tmpdir(), 'aura-web-dist-'));
    writeFileSync(path.join(webDist, 'index.html'), indexHtml);

    afterAll(() => {
      rmSync(webDist, { recursive: true, force: true });
    });

    it('serves index.html at /', async () => {
      app = buildApp({}, { webDistDir: webDist });

      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toBe(indexHtml);
    });

    it('serves index.html for unknown non-API GET routes (SPA fallback)', async () => {
      app = buildApp({}, { webDistDir: webDist });

      const response = await app.inject({ method: 'GET', url: '/library/movies/42' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toBe(indexHtml);
    });

    it('GET /api/health still works', async () => {
      app = buildApp({}, { webDistDir: webDist });

      const response = await app.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string }>().status).toBe('ok');
    });

    it('unknown /api routes return a JSON 404, not index.html', async () => {
      app = buildApp({}, { webDistDir: webDist });

      const response = await app.inject({ method: 'GET', url: '/api/nope' });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json<{ error: string }>().error).toBe('Not Found');
    });

    it('unknown non-GET routes return a JSON 404, not index.html', async () => {
      app = buildApp({}, { webDistDir: webDist });

      const response = await app.inject({ method: 'POST', url: '/library/movies' });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
    });
  });
});
