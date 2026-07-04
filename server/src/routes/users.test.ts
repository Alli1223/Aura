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
import { REFRESH_COOKIE_NAME } from '../auth/refresh.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for the user-management API against a real temporary
// SQLite database. The first registered user is the primary admin; tests
// that need extra admins create and remove them so exactly one enabled
// admin (the primary) remains between tests.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';
const TEMP_PASSWORD = 'temporary-secret-99';
const NEW_PASSWORD = 'brand-new-password-1';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  isEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface Session {
  id: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

let admin: Session; // primary admin (first registered user)

function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function login(username: string, password: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

function refresh(token: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    cookies: { [REFRESH_COOKIE_NAME]: token },
  });
}

function refreshCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((c) => c.name === REFRESH_COOKIE_NAME);
  expect(cookie).toBeDefined();
  return cookie!.value;
}

/** Registers a fresh account via the real endpoint. */
async function registerUser(email?: string): Promise<Session> {
  const username = `user-${randomUUID().slice(0, 18)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD, ...(email === undefined ? {} : { email }) },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string }; accessToken: string }>();
  return {
    id: body.user.id,
    username,
    accessToken: body.accessToken,
    refreshToken: refreshCookie(response),
  };
}

/** Registers a user and promotes them to admin directly in the database. */
async function createSecondAdmin(): Promise<Session> {
  const session = await registerUser();
  await prisma.user.update({ where: { id: session.id }, data: { role: 'admin' } });
  return session;
}

function enabledAdminCount(): Promise<number> {
  return prisma.user.count({ where: { role: 'admin', isEnabled: true } });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-users-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  admin = await registerUser(); // first registered user becomes admin
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('admin route protection', () => {
  it('rejects non-admins with 403 FORBIDDEN on every admin route', async () => {
    const user = await registerUser();
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, Record<string, unknown>?]> = [
      ['GET', '/api/users'],
      ['GET', `/api/users/${user.id}`],
      ['PATCH', `/api/users/${user.id}`, { role: 'admin' }],
      ['POST', `/api/users/${user.id}/password`, { newPassword: NEW_PASSWORD }],
      ['DELETE', `/api/users/${user.id}`],
    ];

    for (const [method, url, payload] of routes) {
      const response = await api(method, url, user.accessToken, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
    }
  });

  it('rejects unauthenticated requests with 401 on every route', async () => {
    for (const [method, url] of [
      ['GET', '/api/users'],
      ['GET', '/api/users/some-id'],
      ['GET', '/api/users/me'],
      ['PATCH', '/api/users/me'],
      ['POST', '/api/users/me/password'],
    ] as const) {
      const response = await api(method, url);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('GET /api/users', () => {
  it('lists every user ordered by creation date without passwordHash', async () => {
    const a = await registerUser();
    const b = await registerUser();

    const response = await api('GET', '/api/users', admin.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('passwordHash');
    const users = response.json<{ users: PublicUser[] }>().users;

    const ids = users.map((u) => u.id);
    expect(ids.indexOf(admin.id)).toBe(0); // primary admin registered first
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));

    const listed = users.find((u) => u.id === a.id)!;
    expect(listed).toMatchObject({
      username: a.username,
      email: null,
      role: 'user',
      isEnabled: true,
      mustChangePassword: false,
      lastLoginAt: null,
    });
    expect(listed.createdAt).toBeTruthy();
  });
});

describe('GET /api/users/:id', () => {
  it('returns a single user in the safe shape', async () => {
    const user = await registerUser();

    const response = await api('GET', `/api/users/${user.id}`, admin.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('passwordHash');
    expect(response.json<{ user: PublicUser }>().user).toMatchObject({
      id: user.id,
      username: user.username,
      role: 'user',
    });
  });

  it('returns 404 NOT_FOUND for a missing user', async () => {
    const response = await api('GET', '/api/users/no-such-user', admin.accessToken);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});

describe('PATCH /api/users/:id', () => {
  it('promotes a user to admin and demotes them back, with audit entries', async () => {
    const user = await registerUser();

    const promote = await api('PATCH', `/api/users/${user.id}`, admin.accessToken, {
      role: 'admin',
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json<{ user: PublicUser }>().user.role).toBe('admin');

    const demote = await api('PATCH', `/api/users/${user.id}`, admin.accessToken, {
      role: 'user',
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json<{ user: PublicUser }>().user.role).toBe('user');

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(dbUser.role).toBe('user');

    const audits = await prisma.auditLog.findMany({
      where: { action: 'user.role_changed', targetId: user.id },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.userId === admin.id && a.targetType === 'user')).toBe(true);
  });

  it('disabling a user revokes their refresh sessions and locks them out', async () => {
    const user = await registerUser();

    const response = await api('PATCH', `/api/users/${user.id}`, admin.accessToken, {
      isEnabled: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: PublicUser }>().user.isEnabled).toBe(false);

    // All refresh sessions are revoked: the old refresh token dies with 401.
    expect((await refresh(user.refreshToken)).statusCode).toBe(401);
    // The still-valid access token is rejected on the next request.
    const me = await api('GET', '/api/auth/me', user.accessToken);
    expect(me.statusCode).toBe(403);
    expect(me.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
    // Login is refused while disabled.
    expect((await login(user.username, PASSWORD)).statusCode).toBe(403);

    expect(
      await prisma.auditLog.findFirst({ where: { action: 'user.disabled', targetId: user.id } }),
    ).not.toBeNull();

    // Re-enabling restores access.
    const enable = await api('PATCH', `/api/users/${user.id}`, admin.accessToken, {
      isEnabled: true,
    });
    expect(enable.statusCode).toBe(200);
    expect((await login(user.username, PASSWORD)).statusCode).toBe(200);
    expect(
      await prisma.auditLog.findFirst({ where: { action: 'user.enabled', targetId: user.id } }),
    ).not.toBeNull();
  });

  it('changes a user email and rejects duplicates with 409 EMAIL_TAKEN', async () => {
    const taken = `taken.${randomUUID().slice(0, 8)}@example.com`;
    await registerUser(taken);
    const user = await registerUser();

    const set = await api('PATCH', `/api/users/${user.id}`, admin.accessToken, {
      email: 'Fresh@Example.com',
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ user: PublicUser }>().user.email).toBe('fresh@example.com');
    expect(
      await prisma.auditLog.findFirst({
        where: { action: 'user.email_changed', targetId: user.id, userId: admin.id },
      }),
    ).not.toBeNull();

    const dup = await api('PATCH', `/api/users/${user.id}`, admin.accessToken, { email: taken });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<ErrorBody>().error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects invalid bodies with 400 VALIDATION', async () => {
    const user = await registerUser();

    for (const payload of [{}, { role: 'superuser' }, { isEnabled: 'yes' }, { email: 'nope' }]) {
      const response = await api('PATCH', `/api/users/${user.id}`, admin.accessToken, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
    }
  });

  it('returns 404 for a missing user', async () => {
    const response = await api('PATCH', '/api/users/no-such-user', admin.accessToken, {
      role: 'user',
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to demote or disable yourself with 409 even when another admin exists', async () => {
    const other = await createSecondAdmin();

    const demote = await api('PATCH', `/api/users/${admin.id}`, admin.accessToken, {
      role: 'user',
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json<ErrorBody>().error.code).toBe('CANNOT_MODIFY_SELF');

    const disable = await api('PATCH', `/api/users/${admin.id}`, admin.accessToken, {
      isEnabled: false,
    });
    expect(disable.statusCode).toBe(409);
    expect(disable.json<ErrorBody>().error.code).toBe('CANNOT_MODIFY_SELF');

    await prisma.user.delete({ where: { id: other.id } });
  });

  it('refuses to demote or disable the last enabled admin with 409 LAST_ADMIN', async () => {
    expect(await enabledAdminCount()).toBe(1);

    const demote = await api('PATCH', `/api/users/${admin.id}`, admin.accessToken, {
      role: 'user',
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json<ErrorBody>().error.code).toBe('LAST_ADMIN');

    const disable = await api('PATCH', `/api/users/${admin.id}`, admin.accessToken, {
      isEnabled: false,
    });
    expect(disable.statusCode).toBe(409);
    expect(disable.json<ErrorBody>().error.code).toBe('LAST_ADMIN');

    const dbAdmin = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(dbAdmin.role).toBe('admin');
    expect(dbAdmin.isEnabled).toBe(true);
  });

  it('demotes and disables an admin normally when another enabled admin exists', async () => {
    const other = await createSecondAdmin();

    const demote = await api('PATCH', `/api/users/${other.id}`, admin.accessToken, {
      role: 'user',
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json<{ user: PublicUser }>().user.role).toBe('user');

    await prisma.user.update({ where: { id: other.id }, data: { role: 'admin' } });
    const disable = await api('PATCH', `/api/users/${other.id}`, admin.accessToken, {
      isEnabled: false,
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json<{ user: PublicUser }>().user.isEnabled).toBe(false);

    await prisma.user.delete({ where: { id: other.id } });
  });
});

describe('DELETE /api/users/:id', () => {
  it('deletes a user; their still-valid token dies on the next request', async () => {
    const user = await registerUser();

    const response = await api('DELETE', `/api/users/${user.id}`, admin.accessToken);

    expect(response.statusCode).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.refreshSession.count({ where: { userId: user.id } })).toBe(0);

    const me = await api('GET', '/api/auth/me', user.accessToken);
    expect(me.statusCode).toBe(401);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'user.deleted', targetId: user.id },
    });
    expect(audit?.userId).toBe(admin.id);
  });

  it('returns 404 for a missing user', async () => {
    const response = await api('DELETE', '/api/users/no-such-user', admin.accessToken);
    expect(response.statusCode).toBe(404);
  });

  it('refuses self-deletion with 409 even when another admin exists', async () => {
    const other = await createSecondAdmin();

    const response = await api('DELETE', `/api/users/${admin.id}`, admin.accessToken);
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('CANNOT_DELETE_SELF');

    await prisma.user.delete({ where: { id: other.id } });
  });

  it('refuses to delete the last enabled admin with 409 LAST_ADMIN', async () => {
    expect(await enabledAdminCount()).toBe(1);

    const response = await api('DELETE', `/api/users/${admin.id}`, admin.accessToken);

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.code).toBe('LAST_ADMIN');
    expect(await prisma.user.findUnique({ where: { id: admin.id } })).not.toBeNull();
  });

  it('deletes an admin normally when another enabled admin exists', async () => {
    const other = await createSecondAdmin();

    const response = await api('DELETE', `/api/users/${other.id}`, admin.accessToken);

    expect(response.statusCode).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: other.id } })).toBeNull();
  });
});

describe('POST /api/users/:id/password (admin reset)', () => {
  it('sets a temporary password, flags mustChangePassword and revokes sessions', async () => {
    const user = await registerUser();

    const response = await api('POST', `/api/users/${user.id}/password`, admin.accessToken, {
      newPassword: TEMP_PASSWORD,
    });
    expect(response.statusCode).toBe(204);

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(dbUser.mustChangePassword).toBe(true);

    // Sessions revoked, old password rejected, temporary password accepted.
    expect((await refresh(user.refreshToken)).statusCode).toBe(401);
    expect((await login(user.username, PASSWORD)).statusCode).toBe(401);
    const relogin = await login(user.username, TEMP_PASSWORD);
    expect(relogin.statusCode).toBe(200);
    expect(relogin.json<{ user: PublicUser }>().user.mustChangePassword).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'user.password_reset_by_admin', targetId: user.id },
    });
    expect(audit?.userId).toBe(admin.id);
  });

  it('does not flag mustChangePassword when an admin resets their own password', async () => {
    const other = await createSecondAdmin();

    const response = await api('POST', `/api/users/${other.id}/password`, other.accessToken, {
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(204);

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(dbUser.mustChangePassword).toBe(false);
    // Sessions are still revoked and the new password works.
    expect((await refresh(other.refreshToken)).statusCode).toBe(401);
    expect((await login(other.username, NEW_PASSWORD)).statusCode).toBe(200);

    await prisma.user.delete({ where: { id: other.id } });
  });

  it('rejects weak passwords with 400 and missing users with 404', async () => {
    const user = await registerUser();

    const weak = await api('POST', `/api/users/${user.id}/password`, admin.accessToken, {
      newPassword: 'short',
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json<ErrorBody>().error.code).toBe('VALIDATION');

    const missing = await api('POST', '/api/users/no-such-user/password', admin.accessToken, {
      newPassword: NEW_PASSWORD,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('mustChangePassword enforcement', () => {
  it('locks a flagged user to the allowlist until they change their password', async () => {
    const user = await registerUser();
    await api('POST', `/api/users/${user.id}/password`, admin.accessToken, {
      newPassword: TEMP_PASSWORD,
    });

    // Login still works and reports the flag so clients can redirect.
    const relogin = await login(user.username, TEMP_PASSWORD);
    expect(relogin.statusCode).toBe(200);
    expect(relogin.json<{ user: PublicUser }>().user.mustChangePassword).toBe(true);
    const accessToken = relogin.json<{ accessToken: string }>().accessToken;
    const refreshToken = refreshCookie(relogin);

    // Refresh also reports the flag.
    const refreshed = await refresh(refreshToken);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json<{ user: PublicUser }>().user.mustChangePassword).toBe(true);

    // Allowlisted routes work…
    const authMe = await api('GET', '/api/auth/me', accessToken);
    expect(authMe.statusCode).toBe(200);
    expect(authMe.json<{ user: PublicUser }>().user.mustChangePassword).toBe(true);
    expect((await api('GET', '/api/users/me', accessToken)).statusCode).toBe(200);

    // …every other authenticated route is blocked.
    const blocked = await api('PATCH', '/api/users/me', accessToken, {
      email: 'blocked@example.com',
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<ErrorBody>().error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // A wrong current password on the change endpoint still returns 401.
    const wrong = await api('POST', '/api/users/me/password', accessToken, {
      currentPassword: 'not-the-temp-password',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<ErrorBody>().error.code).toBe('INVALID_CREDENTIALS');

    // Changing the password through the allowlisted route clears the flag.
    const change = await api('POST', '/api/users/me/password', accessToken, {
      currentPassword: TEMP_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(change.statusCode).toBe(204);

    const me = await api('GET', '/api/auth/me', accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: PublicUser }>().user.mustChangePassword).toBe(false);

    // Full access returns (same access token, next request).
    const unblocked = await api('PATCH', '/api/users/me', accessToken, {
      email: `unblocked.${randomUUID().slice(0, 8)}@example.com`,
    });
    expect(unblocked.statusCode).toBe(200);

    // The new password logs in without the flag.
    const fresh = await login(user.username, NEW_PASSWORD);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json<{ user: PublicUser }>().user.mustChangePassword).toBe(false);
  });
});

describe('GET /api/users/me', () => {
  it('returns the own profile in the safe shape', async () => {
    const user = await registerUser();

    const response = await api('GET', '/api/users/me', user.accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('passwordHash');
    expect(response.json<{ user: PublicUser }>().user).toMatchObject({
      id: user.id,
      username: user.username,
      role: 'user',
    });
  });
});

describe('PATCH /api/users/me', () => {
  it('changes the own email and writes an audit entry', async () => {
    const user = await registerUser();

    const response = await api('PATCH', '/api/users/me', user.accessToken, {
      email: 'Me@Example.com',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: PublicUser }>().user.email).toBe('me@example.com');
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'user.email_changed', targetId: user.id, userId: user.id },
    });
    expect(audit).not.toBeNull();
  });

  it('allows clearing the email with null', async () => {
    const user = await registerUser(`clearme.${randomUUID().slice(0, 8)}@example.com`);

    const response = await api('PATCH', '/api/users/me', user.accessToken, { email: null });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: PublicUser }>().user.email).toBeNull();
  });

  it('rejects duplicate emails with 409 and invalid ones with 400', async () => {
    const taken = `mine.${randomUUID().slice(0, 8)}@example.com`;
    await registerUser(taken);
    const user = await registerUser();

    const dup = await api('PATCH', '/api/users/me', user.accessToken, { email: taken });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<ErrorBody>().error.code).toBe('EMAIL_TAKEN');

    const invalid = await api('PATCH', '/api/users/me', user.accessToken, { email: 'nope' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('POST /api/users/me/password (self change)', () => {
  it('rejects a wrong current password with 401 INVALID_CREDENTIALS', async () => {
    const user = await registerUser();

    const response = await api('POST', '/api/users/me/password', user.accessToken, {
      currentPassword: 'definitely-wrong',
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('INVALID_CREDENTIALS');
    // Nothing changed: old password still logs in.
    expect((await login(user.username, PASSWORD)).statusCode).toBe(200);
  });

  it('changes the password, revokes every session and audits', async () => {
    const user = await registerUser();

    const response = await api('POST', '/api/users/me/password', user.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.statusCode).toBe(204);

    // All devices are logged out: the previous refresh token is revoked.
    expect((await refresh(user.refreshToken)).statusCode).toBe(401);
    // Old password rejected, new password accepted.
    expect((await login(user.username, PASSWORD)).statusCode).toBe(401);
    expect((await login(user.username, NEW_PASSWORD)).statusCode).toBe(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'user.password_changed', targetId: user.id },
    });
    expect(audit?.userId).toBe(user.id);
  });

  it('rejects weak new passwords with 400 VALIDATION', async () => {
    const user = await registerUser();

    const response = await api('POST', '/api/users/me/password', user.accessToken, {
      currentPassword: PASSWORD,
      newPassword: 'password123',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});
