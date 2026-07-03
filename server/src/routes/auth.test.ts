import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { REFRESH_COOKIE_NAME } from '../auth/refresh.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests against a real temporary SQLite database (created via
// `prisma migrate deploy`) and a temporary CONFIG_DIR for secrets.json.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let configDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-auth-test-'));
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
  app = buildApp();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  isEnabled: boolean;
}
interface AuthBody {
  user: PublicUser;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
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

function login(username: string, password: string): Promise<LightMyRequestResponse> {
  return inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

function refresh(token: string): Promise<LightMyRequestResponse> {
  return inject({
    method: 'POST',
    url: '/api/auth/refresh',
    cookies: { [REFRESH_COOKIE_NAME]: token },
  });
}

function refreshCookie(response: LightMyRequestResponse) {
  return response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
}

/** Registers a fresh user and returns its credentials, tokens and id. */
async function createUser() {
  const username = uniqueUsername();
  const response = await register({ username, password: PASSWORD });
  expect(response.statusCode).toBe(201);
  const body = response.json<AuthBody>();
  const cookie = refreshCookie(response);
  expect(cookie).toBeDefined();
  return { username, body, refreshToken: cookie!.value };
}

describe('POST /api/auth/register', () => {
  it('makes the first registered user an admin and returns tokens', async () => {
    expect(await prisma.user.count()).toBe(0);

    const username = uniqueUsername();
    const response = await register({ username, email: 'First@Example.com', password: PASSWORD });

    expect(response.statusCode).toBe(201);
    const body = response.json<AuthBody>();
    expect(body.user.role).toBe('admin');
    expect(body.user.username).toBe(username);
    expect(body.user.email).toBe('first@example.com');
    expect(body.accessToken).toBeTruthy();
    expect(response.body).not.toContain('passwordHash');

    const cookie = refreshCookie(response);
    expect(cookie).toBeDefined();
    expect(cookie).toMatchObject({ path: '/api/auth', httpOnly: true, sameSite: 'Strict' });
    // The raw token must never be stored, only its hash.
    expect(
      await prisma.refreshSession.findFirst({ where: { tokenHash: cookie!.value } }),
    ).toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: 'user.register' } });
    expect(audit?.userId).toBe(body.user.id);
  });

  it('gives every subsequent user the "user" role with zero library access', async () => {
    const { body } = await createUser();

    expect(body.user.role).toBe('user');
    expect(await prisma.libraryAccess.count({ where: { userId: body.user.id } })).toBe(0);
  });

  it('normalises usernames and rejects duplicates with 409', async () => {
    const { username } = await createUser();

    const response = await register({
      username: `  ${username.toUpperCase()}  `,
      password: PASSWORD,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects duplicate emails with 409', async () => {
    const email = `dup.${Date.now().toString(36)}@example.com`;
    await register({ username: uniqueUsername(), email, password: PASSWORD });

    const response = await register({ username: uniqueUsername(), email, password: PASSWORD });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['short password', { username: 'validname', password: 'short' }],
    ['overlong password', { username: 'validname', password: 'x'.repeat(129) }],
    ['common password', { username: 'validname', password: 'password123' }],
    ['short username', { username: 'ab', password: PASSWORD }],
    ['overlong username', { username: 'a'.repeat(33), password: PASSWORD }],
    ['username with invalid characters', { username: 'bad name!', password: PASSWORD }],
    ['invalid email', { username: 'validname', email: 'not-an-email', password: PASSWORD }],
    ['missing body fields', {}],
  ])('rejects %s with 400 VALIDATION', async (_label, payload) => {
    const response = await register(payload);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('POST /api/auth/login', () => {
  it('returns an access token, sets a refresh cookie and updates lastLoginAt', async () => {
    const { username } = await createUser();

    const response = await login(username, PASSWORD);

    expect(response.statusCode).toBe(200);
    const body = response.json<AuthBody>();
    expect(body.accessToken).toBeTruthy();
    expect(body.user.username).toBe(username);
    expect(response.body).not.toContain('passwordHash');

    const cookie = refreshCookie(response);
    expect(cookie).toMatchObject({ path: '/api/auth', httpOnly: true, sameSite: 'Strict' });

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { username } });
    expect(dbUser.lastLoginAt).toBeInstanceOf(Date);

    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.login.success', userId: body.user.id },
    });
    expect(audit).not.toBeNull();
  });

  it('returns the same 401 for unknown usernames and wrong passwords', async () => {
    const { username } = await createUser();

    const unknownUser = await login(`nosuchuser.${Date.now().toString(36)}`, PASSWORD);
    const wrongPassword = await login(username, 'definitely-not-it');

    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.json<ErrorBody>()).toEqual(wrongPassword.json<ErrorBody>());
    expect(refreshCookie(unknownUser)).toBeUndefined();

    const failures = await prisma.auditLog.findMany({ where: { action: 'auth.login.failure' } });
    expect(failures.length).toBeGreaterThanOrEqual(2);
    const attempted = failures.map((f) => JSON.parse(f.details ?? '{}') as { username?: string });
    expect(attempted.some((d) => d.username === username)).toBe(true);
    expect(failures.every((f) => f.ip !== null)).toBe(true);
  });

  it('rejects disabled users with 403 even with correct credentials', async () => {
    const { username, body } = await createUser();
    await prisma.user.update({ where: { id: body.user.id }, data: { isEnabled: false } });

    const response = await login(username, PASSWORD);

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user with a valid token', async () => {
    const { body } = await createUser();

    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: PublicUser }>().user.id).toBe(body.user.id);
    expect(response.body).not.toContain('passwordHash');
  });

  it('rejects requests without a token', async () => {
    const response = await inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects garbage and tampered tokens', async () => {
    const { body } = await createUser();
    const tampered = body.accessToken.slice(0, -2) + 'xx';

    for (const token of ['garbage', tampered]) {
      const response = await inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('rejects expired tokens', async () => {
    const { body } = await createUser();
    const expired = app.jwt.sign(
      { sub: body.user.id, role: body.user.role, username: body.user.username },
      { expiresIn: '1s' },
    );

    await sleep(2100);
    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${expired}` },
    });

    expect(response.statusCode).toBe(401);
  }, 10_000);

  it('rejects users disabled after the token was issued', async () => {
    const { body } = await createUser();
    await prisma.user.update({ where: { id: body.user.id }, data: { isEnabled: false } });

    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the refresh token and returns a fresh access token', async () => {
    const { body, refreshToken } = await createUser();

    const response = await refresh(refreshToken);

    expect(response.statusCode).toBe(200);
    const accessToken = response.json<{ accessToken: string }>().accessToken;
    expect(accessToken).toBeTruthy();

    const cookie = refreshCookie(response);
    expect(cookie).toBeDefined();
    expect(cookie!.value).not.toBe(refreshToken);
    expect(cookie).toMatchObject({ path: '/api/auth', httpOnly: true, sameSite: 'Strict' });

    const me = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: PublicUser }>().user.id).toBe(body.user.id);
  });

  it('rejects requests without a refresh cookie', async () => {
    const response = await inject({ method: 'POST', url: '/api/auth/refresh' });

    expect(response.statusCode).toBe(401);
  });

  it('rejects unknown refresh tokens', async () => {
    const response = await refresh('not-a-real-token');

    expect(response.statusCode).toBe(401);
  });

  it('detects reuse of a rotated token and revokes the whole chain', async () => {
    const { body, refreshToken: token1 } = await createUser();

    const rotate1 = await refresh(token1);
    const token2 = refreshCookie(rotate1)!.value;
    const rotate2 = await refresh(token2);
    const token3 = refreshCookie(rotate2)!.value;

    // Present the original (revoked) token: reuse detection must trip.
    const reuse = await refresh(token1);
    expect(reuse.statusCode).toBe(401);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.refresh.reuse_detected', userId: body.user.id },
    });
    expect(audit).not.toBeNull();

    // ALL descendants are revoked, so the newest (otherwise valid) token dies too.
    const afterReuse = await refresh(token3);
    expect(afterReuse.statusCode).toBe(401);

    const sessions = await prisma.refreshSession.findMany({ where: { userId: body.user.id } });
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it('rejects expired refresh sessions', async () => {
    const { body, refreshToken } = await createUser();
    await prisma.refreshSession.updateMany({
      where: { userId: body.user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await refresh(refreshToken);

    expect(response.statusCode).toBe(401);
  });

  it('rejects refresh for disabled users with 403', async () => {
    const { body, refreshToken } = await createUser();
    await prisma.user.update({ where: { id: body.user.id }, data: { isEnabled: false } });

    const response = await refresh(refreshToken);

    expect(response.statusCode).toBe(403);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the presented session and clears the cookie', async () => {
    const { body, refreshToken } = await createUser();

    const response = await inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [REFRESH_COOKIE_NAME]: refreshToken },
    });

    expect(response.statusCode).toBe(204);
    const cleared = refreshCookie(response);
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe('');

    const sessions = await prisma.refreshSession.findMany({ where: { userId: body.user.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.revokedAt).not.toBeNull();

    // The revoked cookie can no longer be used to refresh.
    expect((await refresh(refreshToken)).statusCode).toBe(401);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.logout', userId: body.user.id },
    });
    expect(audit).not.toBeNull();
  });

  it('is idempotent without a cookie', async () => {
    const response = await inject({ method: 'POST', url: '/api/auth/logout' });

    expect(response.statusCode).toBe(204);
  });
});

describe('JWT signing secret', () => {
  it('persists secrets.json with mode 0600', async () => {
    const secretsPath = path.join(configDir, 'secrets.json');
    const info = await stat(secretsPath);

    expect(info.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(await readFile(secretsPath, 'utf8')) as { jwtSecret: string };
    expect(parsed.jwtSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across app restarts: tokens from one boot verify on the next', async () => {
    const secretsPath = path.join(configDir, 'secrets.json');
    const before = await readFile(secretsPath, 'utf8');
    const { body } = await createUser();

    const secondBoot = buildApp();
    await secondBoot.ready();
    try {
      const response = await secondBoot.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ user: PublicUser }>().user.id).toBe(body.user.id);
    } finally {
      await secondBoot.close();
    }

    expect(await readFile(secretsPath, 'utf8')).toBe(before);
  });
});
