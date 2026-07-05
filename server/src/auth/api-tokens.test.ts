import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { PrismaClient, User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import {
  API_TOKEN_DISPLAY_PREFIX_LENGTH,
  API_TOKEN_PREFIX,
  createApiToken,
  generateApiToken,
  hashApiToken,
  isApiToken,
  touchApiTokenLastUsed,
  verifyApiToken,
} from './api-tokens.js';

// Unit/integration tests for the API-token module against a real temporary
// SQLite database (created via `prisma migrate deploy`).

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;
let userCounter = 0;

async function makeUser(): Promise<User> {
  userCounter += 1;
  return prisma.user.create({
    data: {
      username: `tok-mod-${userCounter}-${Date.now().toString(36)}`,
      passwordHash: 'not-a-real-hash',
      role: 'user',
    },
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-apitoken-mod-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('generateApiToken / hashApiToken / isApiToken', () => {
  it('generates prefixed, unique tokens', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(isApiToken(a)).toBe(true);
    expect(isApiToken('eyJ.jwt.looking')).toBe(false);
    expect(isApiToken('')).toBe(false);
  });

  it('hashes with sha256 hex (matching node crypto)', () => {
    const raw = generateApiToken();
    const hash = hashApiToken(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});

describe('createApiToken', () => {
  it('returns the raw token once and stores only its hash + prefix', async () => {
    const user = await makeUser();
    const { record, rawToken } = await createApiToken(prisma, {
      userId: user.id,
      name: 'CI script',
      scope: 'read',
    });

    expect(isApiToken(rawToken)).toBe(true);

    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: record.id } });
    // The raw token is never persisted; only its hash + a short prefix are.
    expect(stored.tokenHash).toBe(hashApiToken(rawToken));
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.prefix).toBe(rawToken.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH));
    expect(rawToken).not.toContain(stored.tokenHash);
    expect(stored.scope).toBe('read');
    expect(stored.lastUsedAt).toBeNull();
    expect(stored.revokedAt).toBeNull();
  });

  it('persists an optional expiry', async () => {
    const user = await makeUser();
    const expiresAt = new Date(Date.now() + 60_000);
    const { record } = await createApiToken(prisma, {
      userId: user.id,
      name: 'expiring',
      scope: 'full',
      expiresAt,
    });
    expect(record.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });
});

describe('verifyApiToken', () => {
  it('round-trips a valid token to its user + scope', async () => {
    const user = await makeUser();
    const { record, rawToken } = await createApiToken(prisma, {
      userId: user.id,
      name: 'valid',
      scope: 'full',
    });

    const verified = await verifyApiToken(prisma, rawToken);
    expect(verified).not.toBeNull();
    expect(verified!.user.id).toBe(user.id);
    expect(verified!.scope).toBe('full');
    expect(verified!.tokenId).toBe(record.id);
  });

  it('returns null for an unknown token', async () => {
    expect(await verifyApiToken(prisma, generateApiToken())).toBeNull();
  });

  it('returns null for a non-API-token value', async () => {
    expect(await verifyApiToken(prisma, 'not-an-aura-token')).toBeNull();
  });

  it('returns null for a revoked token', async () => {
    const user = await makeUser();
    const { record, rawToken } = await createApiToken(prisma, {
      userId: user.id,
      name: 'revoked',
      scope: 'read',
    });
    await prisma.apiToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });

    expect(await verifyApiToken(prisma, rawToken)).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const user = await makeUser();
    const { record, rawToken } = await createApiToken(prisma, {
      userId: user.id,
      name: 'expired',
      scope: 'read',
      expiresAt: new Date(Date.now() + 10_000),
    });
    // Verify with a "now" past the expiry.
    expect(await verifyApiToken(prisma, rawToken, Date.now() + 20_000)).toBeNull();
    // Sanity: still valid before expiry.
    expect(await verifyApiToken(prisma, rawToken)).not.toBeNull();
    expect(record.id).toBeTruthy();
  });

  it('fails closed on an unrecognised stored scope', async () => {
    const user = await makeUser();
    const rawToken = generateApiToken();
    await prisma.apiToken.create({
      data: {
        userId: user.id,
        name: 'bad-scope',
        tokenHash: hashApiToken(rawToken),
        prefix: rawToken.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
        scope: 'superuser',
      },
    });
    expect(await verifyApiToken(prisma, rawToken)).toBeNull();
  });
});

describe('touchApiTokenLastUsed', () => {
  it('updates lastUsedAt best-effort', async () => {
    const user = await makeUser();
    const { record } = await createApiToken(prisma, {
      userId: user.id,
      name: 'touch',
      scope: 'full',
    });

    touchApiTokenLastUsed(prisma, record.id);

    let lastUsedAt: Date | null = null;
    for (let i = 0; i < 20 && lastUsedAt === null; i += 1) {
      await sleep(25);
      lastUsedAt = (await prisma.apiToken.findUniqueOrThrow({ where: { id: record.id } }))
        .lastUsedAt;
    }
    expect(lastUsedAt).toBeInstanceOf(Date);
  });

  it('never throws for an unknown token id', async () => {
    expect(() => touchApiTokenLastUsed(prisma, 'does-not-exist')).not.toThrow();
    // Give the fire-and-forget update a tick to reject-and-swallow.
    await sleep(50);
  });
});
