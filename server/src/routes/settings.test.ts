import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import {
  clearSettingsCache,
  getAllSettings,
  getSetting,
  setSettings,
  type SettingsPatch,
} from '../lib/settings.js';

// Integration tests against a real temporary SQLite database (created via
// `prisma migrate deploy`) and a temporary CONFIG_DIR.
//
// Test order matters within this file: the registration-toggle tests need an
// EMPTY user table (first-run exception), so they run before anything else
// registers a user, and the service-level tests before them touch no users.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let configDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let adminToken: string;
let adminId: string;
let userToken: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-settings-test-'));
  configDir = path.join(tempDir, 'config');
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = configDir;
  prisma = getPrisma();
  clearSettingsCache();
  app = buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

interface ErrorBody {
  error: { code: string; message: string };
}
interface SettingsBody {
  settings: {
    serverName: string;
    registrationEnabled: boolean;
    baseUrl: string;
    transcodeDir: string;
    defaultQuality: string;
    maxQuality: string;
    blockUnratedForRestrictedUsers: boolean;
    tmdbApiKey: string;
  };
}
interface AuthBody {
  user: { id: string; role: string };
  accessToken: string;
}

let userCounter = 0;
function uniqueUsername(): string {
  userCounter += 1;
  return `user${userCounter}.${Date.now().toString(36)}`;
}

function inject(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(options);
}

function register(payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return inject({ method: 'POST', url: '/api/auth/register', payload });
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function getSettings(token?: string): Promise<LightMyRequestResponse> {
  return inject({
    method: 'GET',
    url: '/api/settings',
    headers: token === undefined ? {} : authHeaders(token),
  });
}

function patchSettings(
  payload: Record<string, unknown>,
  token?: string,
): Promise<LightMyRequestResponse> {
  return inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: token === undefined ? {} : authHeaders(token),
    payload,
  });
}

function fakeLog(): { log: FastifyBaseLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { log: { warn } as unknown as FastifyBaseLogger, warn };
}

describe('settings service', () => {
  it('returns the default for every setting on an empty database', async () => {
    expect(await prisma.setting.count()).toBe(0);
    clearSettingsCache();

    expect(await getAllSettings()).toEqual({
      serverName: 'Aura',
      registrationEnabled: true,
      baseUrl: '',
      transcodeDir: path.join(configDir, 'transcodes'),
      defaultQuality: '720p',
      maxQuality: '1080p',
      blockUnratedForRestrictedUsers: false,
      tmdbApiKey: '',
    });
  });

  it('round-trips setSettings -> getSetting, JSON-encoded and persistent', async () => {
    await setSettings({ serverName: 'Round Trip' });

    expect(await getSetting('serverName')).toBe('Round Trip');
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'serverName' } });
    expect(row.value).toBe(JSON.stringify('Round Trip'));

    // Survives a cache clear: the value is read back from the database.
    clearSettingsCache();
    expect(await getSetting('serverName')).toBe('Round Trip');

    await prisma.setting.delete({ where: { key: 'serverName' } });
    clearSettingsCache();
  });

  it('rejects unknown keys in setSettings', async () => {
    await expect(setSettings({ nope: true } as unknown as SettingsPatch)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION',
    });
    expect(await prisma.setting.count()).toBe(0);
  });

  it('rejects invalid values in setSettings', async () => {
    await expect(setSettings({ baseUrl: 'https://media.example.com/' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION',
    });
  });

  it('falls back to the default with a warning when stored JSON is invalid', async () => {
    await prisma.setting.create({ data: { key: 'serverName', value: '{not valid json' } });
    clearSettingsCache();
    const { log, warn } = fakeLog();

    expect(await getSetting('serverName', log)).toBe('Aura');
    expect(warn).toHaveBeenCalledTimes(1);

    await prisma.setting.delete({ where: { key: 'serverName' } });
    clearSettingsCache();
  });

  it('falls back to the default with a warning when a stored value fails its schema', async () => {
    await prisma.setting.create({ data: { key: 'registrationEnabled', value: '"yes"' } });
    clearSettingsCache();
    const { log, warn } = fakeLog();

    expect(await getSetting('registrationEnabled', log)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    await prisma.setting.delete({ where: { key: 'registrationEnabled' } });
    clearSettingsCache();
  });
});

describe('registration toggle', () => {
  it('always allows the first registration even when registration is disabled', async () => {
    await prisma.setting.create({ data: { key: 'registrationEnabled', value: 'false' } });
    clearSettingsCache();
    expect(await prisma.user.count()).toBe(0);

    const response = await register({ username: uniqueUsername(), password: PASSWORD });

    expect(response.statusCode).toBe(201);
    const body = response.json<AuthBody>();
    expect(body.user.role).toBe('admin');
    adminToken = body.accessToken;
    adminId = body.user.id;
  });

  it('blocks registration with 403 REGISTRATION_DISABLED once a user exists', async () => {
    const before = await prisma.user.count();
    const response = await register({ username: uniqueUsername(), password: PASSWORD });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('REGISTRATION_DISABLED');
    expect(await prisma.user.count()).toBe(before);
  });

  it('PATCH re-enables registration and takes effect immediately', async () => {
    const patch = await patchSettings({ registrationEnabled: true }, adminToken);
    expect(patch.statusCode).toBe(200);
    expect(patch.json<SettingsBody>().settings.registrationEnabled).toBe(true);

    const response = await register({ username: uniqueUsername(), password: PASSWORD });
    expect(response.statusCode).toBe(201);
    const body = response.json<AuthBody>();
    expect(body.user.role).toBe('user');
    userToken = body.accessToken;
  });

  it('PATCH disabling registration blocks register immediately', async () => {
    const patch = await patchSettings({ registrationEnabled: false }, adminToken);
    expect(patch.statusCode).toBe(200);

    const blocked = await register({ username: uniqueUsername(), password: PASSWORD });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<ErrorBody>().error.code).toBe('REGISTRATION_DISABLED');

    // Restore for the remaining tests.
    expect((await patchSettings({ registrationEnabled: true }, adminToken)).statusCode).toBe(200);
  });
});

describe('GET /api/settings', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const response = await getSettings();

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects non-admin users with 403', async () => {
    const response = await getSettings(userToken);

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it('returns every setting with typed values for admins', async () => {
    const response = await getSettings(adminToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<SettingsBody>().settings).toEqual({
      serverName: 'Aura',
      registrationEnabled: true,
      baseUrl: '',
      transcodeDir: path.join(configDir, 'transcodes'),
      defaultQuality: '720p',
      maxQuality: '1080p',
      blockUnratedForRestrictedUsers: false,
      tmdbApiKey: '',
    });
  });
});

describe('PATCH /api/settings', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const response = await patchSettings({ serverName: 'Nope' });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects non-admin users with 403', async () => {
    const response = await patchSettings({ serverName: 'Nope' }, userToken);

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it('updates settings and an immediate GET reflects the change', async () => {
    const response = await patchSettings(
      {
        serverName: 'Aura HQ',
        baseUrl: 'https://media.example.com',
        transcodeDir: '/tmp/aura-transcodes',
      },
      adminToken,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<SettingsBody>().settings).toEqual({
      serverName: 'Aura HQ',
      registrationEnabled: true,
      baseUrl: 'https://media.example.com',
      transcodeDir: '/tmp/aura-transcodes',
      defaultQuality: '720p',
      maxQuality: '1080p',
      blockUnratedForRestrictedUsers: false,
      tmdbApiKey: '',
    });

    // Cache invalidation: no restart, the next read sees the new values.
    const readBack = await getSettings(adminToken);
    expect(readBack.statusCode).toBe(200);
    expect(readBack.json<SettingsBody>().settings.serverName).toBe('Aura HQ');
    expect(readBack.json<SettingsBody>().settings.baseUrl).toBe('https://media.example.com');
  });

  it('persists settings across a second buildApp() on the same database', async () => {
    clearSettingsCache();
    const secondBoot = buildApp();
    await secondBoot.ready();
    try {
      const response = await secondBoot.inject({
        method: 'GET',
        url: '/api/settings',
        headers: authHeaders(adminToken),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<SettingsBody>().settings).toEqual({
        serverName: 'Aura HQ',
        registrationEnabled: true,
        baseUrl: 'https://media.example.com',
        transcodeDir: '/tmp/aura-transcodes',
        defaultQuality: '720p',
        maxQuality: '1080p',
        blockUnratedForRestrictedUsers: false,
        tmdbApiKey: '',
      });
    } finally {
      await secondBoot.close();
    }
  });

  it('writes a settings.updated audit row with the changed keys and values', async () => {
    const rows = await prisma.auditLog.findMany({ where: { action: 'settings.updated' } });

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const details = rows.map((row) => JSON.parse(row.details ?? '{}') as { changed?: object });
    expect(details).toContainEqual({
      changed: {
        serverName: 'Aura HQ',
        baseUrl: 'https://media.example.com',
        transcodeDir: '/tmp/aura-transcodes',
      },
    });
    expect(rows.every((row) => row.userId === adminId)).toBe(true);
    expect(rows.every((row) => row.ip !== null)).toBe(true);
  });

  it.each([
    ['a non-string serverName', { serverName: 123 }],
    ['an empty serverName', { serverName: '' }],
    ['a whitespace-only serverName', { serverName: '   ' }],
    ['an overlong serverName', { serverName: 'x'.repeat(65) }],
    ['a non-boolean registrationEnabled', { registrationEnabled: 'yes' }],
    ['a non-string transcodeDir', { transcodeDir: 42 }],
    ['an empty transcodeDir', { transcodeDir: '' }],
    ['a non-string tmdbApiKey', { tmdbApiKey: 42 }],
    ['an overlong tmdbApiKey', { tmdbApiKey: 'x'.repeat(513) }],
    ['a non-ladder defaultQuality', { defaultQuality: '4k' }],
    ['a non-ladder maxQuality', { maxQuality: 'ultra' }],
    ['a numeric defaultQuality', { defaultQuality: 720 }],
    ['an unknown key', { serverName: 'ok', accentColor: 'red' }],
    ['an empty patch', {}],
    ['a baseUrl with a trailing slash', { baseUrl: 'https://media.example.com/' }],
    ['a baseUrl with a non-http scheme', { baseUrl: 'ftp://media.example.com' }],
    ['a baseUrl that is not a URL', { baseUrl: 'not a url' }],
  ])('rejects %s with 400 VALIDATION', async (_label, payload) => {
    const before = await getSettings(adminToken);
    const response = await patchSettings(payload, adminToken);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
    // Nothing was written.
    const after = await getSettings(adminToken);
    expect(after.json<SettingsBody>()).toEqual(before.json<SettingsBody>());
  });

  it.each([
    ['an http URL with a port', 'http://localhost:8096'],
    ['an https URL with a path', 'https://example.com/aura'],
    ['the empty string (unset)', ''],
  ])('accepts %s as baseUrl', async (_label, baseUrl) => {
    const response = await patchSettings({ baseUrl }, adminToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<SettingsBody>().settings.baseUrl).toBe(baseUrl);
  });
});

describe('quality settings', () => {
  it('admins can set defaultQuality and maxQuality to any ladder rung', async () => {
    const response = await patchSettings(
      { defaultQuality: '480p', maxQuality: '720p' },
      adminToken,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<SettingsBody>().settings.defaultQuality).toBe('480p');
    expect(response.json<SettingsBody>().settings.maxQuality).toBe('720p');
    expect(await getSetting('defaultQuality')).toBe('480p');
    expect(await getSetting('maxQuality')).toBe('720p');

    // Restore the defaults for any later tests.
    expect(
      (await patchSettings({ defaultQuality: '720p', maxQuality: '1080p' }, adminToken)).statusCode,
    ).toBe(200);
  });

  it('rejects a non-ladder quality with 400 VALIDATION', async () => {
    for (const payload of [{ defaultQuality: '2160p' }, { maxQuality: 'potato' }]) {
      const response = await patchSettings(payload, adminToken);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
    }
  });
});

describe('GET /api/settings/public', () => {
  it('is reachable without auth and exposes exactly serverName and registrationEnabled', async () => {
    const response = await inject({ method: 'GET', url: '/api/settings/public' });

    expect(response.statusCode).toBe(200);
    // Exact shape: nothing else (baseUrl, transcodeDir, ...) may leak here.
    expect(response.json()).toEqual({ serverName: 'Aura HQ', registrationEnabled: true });
  });

  it('reflects settings changes immediately', async () => {
    const patch = await patchSettings({ serverName: 'Renamed' }, adminToken);
    expect(patch.statusCode).toBe(200);

    const response = await inject({ method: 'GET', url: '/api/settings/public' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ serverName: 'Renamed', registrationEnabled: true });
  });
});

describe('tmdbApiKey setting', () => {
  it('PATCH stores the key (trimmed) and GET returns it to admins', async () => {
    const response = await patchSettings({ tmdbApiKey: '  0123456789abcdef  ' }, adminToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<SettingsBody>().settings.tmdbApiKey).toBe('0123456789abcdef');
    expect(await getSetting('tmdbApiKey')).toBe('0123456789abcdef');
  });

  it('never appears in GET /api/settings/public, even when set', async () => {
    expect(await getSetting('tmdbApiKey')).not.toBe('');

    const response = await inject({ method: 'GET', url: '/api/settings/public' });

    expect(response.statusCode).toBe(200);
    // Exact shape: the API key (and everything else non-public) must not leak.
    expect(response.json()).toEqual({ serverName: 'Renamed', registrationEnabled: true });
  });

  it('redacts the key value in the settings.updated audit log entry', async () => {
    const rows = await prisma.auditLog.findMany({ where: { action: 'settings.updated' } });
    const details = rows.map((row) => JSON.parse(row.details ?? '{}') as { changed?: object });

    expect(details).toContainEqual({ changed: { tmdbApiKey: '[REDACTED]' } });
    // The raw key value must not appear anywhere in the audit log.
    for (const row of rows) {
      expect(row.details ?? '').not.toContain('0123456789abcdef');
    }
  });

  it('accepts clearing the key back to ""', async () => {
    const response = await patchSettings({ tmdbApiKey: '' }, adminToken);

    expect(response.statusCode).toBe(200);
    expect(response.json<SettingsBody>().settings.tmdbApiKey).toBe('');
  });
});
