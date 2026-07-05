import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for personal API tokens: management routes, the
// authenticate integration (JWT vs token, scopes) and role gating. Runs
// against a real temporary SQLite database.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface PublicToken {
  id: string;
  name: string;
  scope: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}
interface CreateTokenBody {
  token: PublicToken;
  plaintext: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface Session {
  id: string;
  username: string;
  accessToken: string;
}

let admin: Session;

function inject(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(options);
}

/** Bearer <jwt> auth header. */
function jwtAuth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function registerUser(): Promise<Session> {
  const username = `apitok-${randomUUID().slice(0, 18)}`;
  const response = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string }; accessToken: string }>();
  return { id: body.user.id, username, accessToken: body.accessToken };
}

async function createToken(
  session: Session,
  payload: Record<string, unknown>,
): Promise<CreateTokenBody> {
  const response = await inject({
    method: 'POST',
    url: '/api/api-tokens',
    headers: jwtAuth(session.accessToken),
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreateTokenBody>();
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-apitoken-test-'));
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
  // First registered user becomes the admin.
  admin = await registerUser();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Management routes
// ---------------------------------------------------------------------------

describe('POST /api/api-tokens', () => {
  it('returns metadata + the raw token once and audits (name+scope, not token)', async () => {
    const user = await registerUser();
    const before = new Date();
    const body = await createToken(user, { name: 'CI deploy', scope: 'full' });

    expect(body.plaintext).toMatch(/^aura_/);
    expect(body.token.name).toBe('CI deploy');
    expect(body.token.scope).toBe('full');
    expect(body.token.prefix.startsWith('aura_')).toBe(true);
    expect(body.token.revokedAt).toBeNull();
    // Metadata never carries the secret or its hash.
    expect(JSON.stringify(body.token)).not.toContain(body.plaintext);

    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: body.token.id } });
    expect(stored.tokenHash).not.toBe(body.plaintext);
    expect(stored.userId).toBe(user.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'api_token.created', targetId: body.token.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(user.id);
    expect(audit!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    const details = JSON.parse(audit!.details ?? '{}') as Record<string, unknown>;
    expect(details).toEqual({ name: 'CI deploy', scope: 'full' });
    // The audit row must never leak the raw token.
    expect(audit!.details).not.toContain(body.plaintext);
  });

  it('accepts a future expiresAt and rejects a past one', async () => {
    const user = await registerUser();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await createToken(user, { name: 'expiring', scope: 'read', expiresAt: future });
    expect(new Date(ok.token.expiresAt!).toISOString()).toBe(future);

    const past = await inject({
      method: 'POST',
      url: '/api/api-tokens',
      headers: jwtAuth(user.accessToken),
      payload: { name: 'stale', scope: 'read', expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it.each([
    ['missing name', { scope: 'read' }],
    ['blank name', { name: '   ', scope: 'read' }],
    ['unknown scope', { name: 'x', scope: 'admin' }],
    ['missing scope', { name: 'x' }],
  ])('rejects %s with 400 VALIDATION', async (_label, payload) => {
    const user = await registerUser();
    const response = await inject({
      method: 'POST',
      url: '/api/api-tokens',
      headers: jwtAuth(user.accessToken),
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('requires authentication', async () => {
    const response = await inject({ method: 'POST', url: '/api/api-tokens', payload: { name: 'x', scope: 'read' } });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/api-tokens', () => {
  it('lists only the caller’s tokens and never leaks hash/raw', async () => {
    const user = await registerUser();
    const other = await registerUser();
    const created = await createToken(user, { name: 'mine', scope: 'read' });
    await createToken(other, { name: 'theirs', scope: 'full' });

    const response = await inject({
      method: 'GET',
      url: '/api/api-tokens',
      headers: jwtAuth(user.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const { tokens } = response.json<{ tokens: PublicToken[] }>();
    expect(tokens.map((t) => t.id)).toEqual([created.token.id]);
    expect(tokens.map((t) => t.name)).toEqual(['mine']);

    // No hash/raw fields anywhere in the payload.
    expect(response.body).not.toContain(created.plaintext);
    expect(response.body.toLowerCase()).not.toContain('hash');
    expect(response.body).not.toContain('tokenHash');
    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: created.token.id } });
    expect(response.body).not.toContain(stored.tokenHash);
  });
});

describe('DELETE /api/api-tokens/:id', () => {
  it('revokes (204), is idempotent, and the token stops authenticating', async () => {
    const user = await registerUser();
    const created = await createToken(user, { name: 'to-revoke', scope: 'full' });

    // Works before revocation.
    const beforeUse = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-api-token': created.plaintext },
    });
    expect(beforeUse.statusCode).toBe(200);

    const first = await inject({
      method: 'DELETE',
      url: `/api/api-tokens/${created.token.id}`,
      headers: jwtAuth(user.accessToken),
    });
    expect(first.statusCode).toBe(204);

    // Idempotent: revoking again still 204.
    const second = await inject({
      method: 'DELETE',
      url: `/api/api-tokens/${created.token.id}`,
      headers: jwtAuth(user.accessToken),
    });
    expect(second.statusCode).toBe(204);

    // The revoked token no longer authenticates.
    const afterUse = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-api-token': created.plaintext },
    });
    expect(afterUse.statusCode).toBe(401);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'api_token.revoked', targetId: created.token.id },
    });
    expect(audit).not.toBeNull();
  });

  it('cloaks another user’s token — and a nonexistent id — as 404', async () => {
    const user = await registerUser();
    const other = await registerUser();
    const theirs = await createToken(other, { name: 'theirs', scope: 'read' });

    const cross = await inject({
      method: 'DELETE',
      url: `/api/api-tokens/${theirs.token.id}`,
      headers: jwtAuth(user.accessToken),
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    const missing = await inject({
      method: 'DELETE',
      url: '/api/api-tokens/does-not-exist',
      headers: jwtAuth(user.accessToken),
    });
    expect(missing.statusCode).toBe(404);

    // The victim's token is untouched.
    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: theirs.token.id } });
    expect(stored.revokedAt).toBeNull();
  });
});

describe('token management via an API token is forbidden (no self-propagation)', () => {
  it('rejects list/create/revoke authenticated by a token with 403', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'full', scope: 'full' });
    const header = { 'x-api-token': full.plaintext };

    const list = await inject({ method: 'GET', url: '/api/api-tokens', headers: header });
    expect(list.statusCode).toBe(403);
    expect(list.json<ErrorBody>().error.code).toBe('API_TOKEN_FORBIDDEN');

    const revoke = await inject({
      method: 'DELETE',
      url: `/api/api-tokens/${full.token.id}`,
      headers: header,
    });
    // A full token may DELETE at the scope layer, but token management is
    // blocked (a read token would be stopped earlier by the scope gate).
    expect(revoke.statusCode).toBe(403);
    expect(revoke.json<ErrorBody>().error.code).toBe('API_TOKEN_FORBIDDEN');

    // The token still exists and works (it was never allowed to revoke itself).
    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: full.token.id } });
    expect(stored.revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// authenticate integration
// ---------------------------------------------------------------------------

describe('authenticate: JWT vs API token', () => {
  it('still authenticates a normal JWT session (regression)', async () => {
    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: jwtAuth(admin.accessToken),
    });
    expect(response.statusCode).toBe(200);
  });

  it('authenticates a full token via X-Api-Token and via Authorization: Bearer aura_', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'full', scope: 'full' });

    const viaHeader = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-api-token': full.plaintext },
    });
    expect(viaHeader.statusCode).toBe(200);
    expect(viaHeader.json<{ user: { id: string } }>().user.id).toBe(user.id);

    const viaBearer = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${full.plaintext}` },
    });
    expect(viaBearer.statusCode).toBe(200);
    expect(viaBearer.json<{ user: { id: string } }>().user.id).toBe(user.id);
  });

  it('lets a full token perform a write (POST)', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'full-writer', scope: 'full' });

    const response = await inject({
      method: 'POST',
      url: '/api/items/state',
      headers: { 'x-api-token': full.plaintext },
      payload: { ids: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ states: Record<string, unknown> }>().states).toEqual({});
  });

  it('updates lastUsedAt after a token is used', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'used', scope: 'full' });
    expect(full.token.lastUsedAt).toBeNull();

    await inject({ method: 'GET', url: '/api/auth/me', headers: { 'x-api-token': full.plaintext } });

    let lastUsedAt: Date | null = null;
    for (let i = 0; i < 20 && lastUsedAt === null; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      lastUsedAt = (await prisma.apiToken.findUniqueOrThrow({ where: { id: full.token.id } }))
        .lastUsedAt;
    }
    expect(lastUsedAt).toBeInstanceOf(Date);
  });

  it('allows GET but blocks POST/PATCH/DELETE for a read token (403 READ_ONLY_TOKEN)', async () => {
    const user = await registerUser();
    const read = await createToken(user, { name: 'reader', scope: 'read' });
    const header = { 'x-api-token': read.plaintext };

    const get = await inject({ method: 'GET', url: '/api/auth/me', headers: header });
    expect(get.statusCode).toBe(200);

    const post = await inject({
      method: 'POST',
      url: '/api/users/me/password',
      headers: header,
      payload: { currentPassword: PASSWORD, newPassword: 'another-strong-secret-1' },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json<ErrorBody>().error.code).toBe('READ_ONLY_TOKEN');

    const patch = await inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: header,
      payload: { email: 'reader@example.com' },
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json<ErrorBody>().error.code).toBe('READ_ONLY_TOKEN');

    const del = await inject({
      method: 'DELETE',
      url: `/api/api-tokens/${read.token.id}`,
      headers: header,
    });
    expect(del.statusCode).toBe(403);
    expect(del.json<ErrorBody>().error.code).toBe('READ_ONLY_TOKEN');

    // The read token never mutated anything.
    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: read.token.id } });
    expect(stored.revokedAt).toBeNull();
  });

  it('rejects an unknown/garbage aura_ token with 401', async () => {
    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-api-token': 'aura_deadbeefdeadbeefdeadbeef' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a disabled user’s token with 401', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'soon-disabled', scope: 'full' });
    await prisma.user.update({ where: { id: user.id }, data: { isEnabled: false } });

    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-api-token': full.plaintext },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a deleted user’s token with 401 (cascade-removed)', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'soon-deleted', scope: 'full' });
    await prisma.user.delete({ where: { id: user.id } });

    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-api-token': full.plaintext },
    });
    expect(response.statusCode).toBe(401);
    expect(await prisma.apiToken.findUnique({ where: { id: full.token.id } })).toBeNull();
  });

  it('rejects a token when the owner must change their password', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'pw-locked', scope: 'full' });
    await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });

    const response = await inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-api-token': full.plaintext },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// Scope vs role: a full token is NOT admin unless the user is admin
// ---------------------------------------------------------------------------

describe('scope does not grant role', () => {
  it('a non-admin’s full token is still 403 on an admin route', async () => {
    const user = await registerUser();
    const full = await createToken(user, { name: 'not-admin', scope: 'full' });

    const response = await inject({
      method: 'GET',
      url: '/api/users',
      headers: { 'x-api-token': full.plaintext },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it('an admin’s full token reaches an admin route', async () => {
    const full = await createToken(admin, { name: 'admin-token', scope: 'full' });

    const response = await inject({
      method: 'GET',
      url: '/api/users',
      headers: { 'x-api-token': full.plaintext },
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json<{ users: unknown[] }>().users)).toBe(true);
  });
});
