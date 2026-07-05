import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { clearSettingsCache, setSettings } from '../lib/settings.js';

// Integration tests for GET /api/qualities: the per-user selectable quality
// rungs the player's menu is built from. The endpoint must only ever offer
// rungs at or below the user's effective cap.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface Session {
  id: string;
  accessToken: string;
}
interface QualitiesBody {
  maxQuality: string;
  defaultQuality: string;
  qualities: Array<{ name: string; maxWidth: number; videoBitrate: string; audioBitrate: string }>;
}
interface ErrorBody {
  error: { code: string; message: string };
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

function getQualities(token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: '/api/qualities',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

function names(body: QualitiesBody): string[] {
  return body.qualities.map((rung) => rung.name);
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-qualities-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  prisma = getPrisma();
  clearSettingsCache();
  app = buildApp();
  await app.ready();

  await registerUser(); // first registered user becomes admin
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('GET /api/qualities', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const response = await getQualities();
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('offers the full ladder to an uncapped user (server defaults)', async () => {
    const user = await registerUser();
    const response = await getQualities(user.accessToken);

    expect(response.statusCode).toBe(200);
    const body = response.json<QualitiesBody>();
    expect(body.maxQuality).toBe('1080p');
    expect(body.defaultQuality).toBe('720p');
    expect(names(body)).toEqual(['1080p', '720p', '480p', '360p']);
    // Each rung carries the fields the player menu needs.
    expect(body.qualities[0]).toMatchObject({
      name: '1080p',
      maxWidth: 1920,
      videoBitrate: '6000k',
      audioBitrate: '192k',
    });
  });

  it('offers only permitted rungs to a user with a personal cap', async () => {
    const user = await registerUser();
    await prisma.user.update({ where: { id: user.id }, data: { maxQuality: '480p' } });

    const response = await getQualities(user.accessToken);
    expect(response.statusCode).toBe(200);
    const body = response.json<QualitiesBody>();

    expect(body.maxQuality).toBe('480p');
    // The server default (720p) is clamped to the user's cap so the UI default
    // is always selectable.
    expect(body.defaultQuality).toBe('480p');
    expect(names(body)).toEqual(['480p', '360p']);
  });

  it('reflects a lowered server-wide maxQuality for an uncapped user', async () => {
    clearSettingsCache();
    await setSettings({ maxQuality: '720p' });
    try {
      const user = await registerUser(); // no personal cap
      const response = await getQualities(user.accessToken);
      expect(response.statusCode).toBe(200);
      const body = response.json<QualitiesBody>();

      expect(body.maxQuality).toBe('720p');
      expect(names(body)).toEqual(['720p', '480p', '360p']);
    } finally {
      await setSettings({ maxQuality: '1080p' });
    }
  });
});
