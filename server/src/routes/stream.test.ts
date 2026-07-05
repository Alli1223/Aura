import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { DEFAULT_STREAM_TOKEN_TTL_MS } from '../config.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { secretsFilePath } from '../lib/secrets.js';
import { verifyStreamToken } from '../streaming/stream-tokens.js';

// Integration tests for POST /api/stream/token against a real temporary
// SQLite database and CONFIG_DIR. Media rows are seeded directly through
// prisma (the scanner is a separate feature); users, grants and tokens all
// flow through the real API. Issued tokens are verified out-of-band with the
// streamTokenSecret read straight from the generated secrets.json.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let configDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let streamTokenSecret: string;
let admin: Session; // first registered user

interface Session {
  id: string;
  username: string;
  accessToken: string;
}
interface TokenBody {
  token: string;
  expiresAt: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

function postToken(mediaFileId: unknown, accessToken?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/stream/token',
    headers: accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
    payload: mediaFileId === undefined ? {} : { mediaFileId },
  });
}

/** Registers a fresh account via the real endpoint. */
async function registerUser(): Promise<Session> {
  const username = `user-${randomUUID().slice(0, 18)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string }; accessToken: string }>();
  return { id: body.user.id, username, accessToken: body.accessToken };
}

/** Seeds a library with one movie backed by one file, straight into the DB. */
async function createLibraryWithFile(): Promise<{
  libraryId: string;
  mediaItemId: string;
  mediaFileId: string;
}> {
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title: 'Test Movie', sortTitle: 'test movie' },
  });
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId: item.id,
      path: `/media/movies/test-${randomUUID()}.mkv`,
      size: BigInt(1_500_000_000),
      mtimeMs: BigInt(Date.now()),
    },
  });
  return { libraryId: library.id, mediaItemId: item.id, mediaFileId: file.id };
}

function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-stream-test-'));
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

  const secrets = JSON.parse(await readFile(secretsFilePath(configDir), 'utf8')) as {
    streamTokenSecret: string;
  };
  streamTokenSecret = secrets.streamTokenSecret;

  admin = await registerUser(); // first registered user becomes admin
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('POST /api/stream/token authentication', () => {
  it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
    const { mediaFileId } = await createLibraryWithFile();
    const response = await postToken(mediaFileId);

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a disabled user even for a library they were granted', async () => {
    const user = await registerUser();
    const { libraryId, mediaFileId } = await createLibraryWithFile();
    await grantAccess(user.id, libraryId);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${user.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { isEnabled: false },
    });
    expect(disable.statusCode).toBe(200);

    const response = await postToken(mediaFileId, user.accessToken);

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('POST /api/stream/token issuance', () => {
  it('issues a verifiable token bound to the requesting user and file', async () => {
    const user = await registerUser();
    const { libraryId, mediaFileId } = await createLibraryWithFile();
    await grantAccess(user.id, libraryId);

    const before = Date.now();
    const response = await postToken(mediaFileId, user.accessToken);
    const after = Date.now();

    expect(response.statusCode).toBe(200);
    const body = response.json<TokenBody>();
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token']);

    // The token must survive being embedded in a URL byte-for-byte.
    expect(encodeURIComponent(body.token)).toBe(body.token);

    const verified = verifyStreamToken(body.token, streamTokenSecret);
    expect(verified).toEqual({
      ok: true,
      claims: {
        userId: user.id,
        mediaFileId,
        expiresAt: new Date(body.expiresAt),
      },
    });

    // expiresAt ~= now + default TTL (6h): bounded by timestamps taken
    // around the request, so this cannot flake on a slow machine.
    const expiresAtMs = Date.parse(body.expiresAt);
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + DEFAULT_STREAM_TOKEN_TTL_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(after + DEFAULT_STREAM_TOKEN_TTL_MS);
  });

  it('binds tokens to whoever requested them, not to earlier requesters', async () => {
    const userA = await registerUser();
    const userB = await registerUser();
    const { libraryId, mediaFileId } = await createLibraryWithFile();
    await grantAccess(userA.id, libraryId);
    await grantAccess(userB.id, libraryId);

    const tokenA = (await postToken(mediaFileId, userA.accessToken)).json<TokenBody>().token;
    const tokenB = (await postToken(mediaFileId, userB.accessToken)).json<TokenBody>().token;

    const verifiedA = verifyStreamToken(tokenA, streamTokenSecret);
    const verifiedB = verifyStreamToken(tokenB, streamTokenSecret);
    expect(verifiedA.ok && verifiedA.claims.userId).toBe(userA.id);
    expect(verifiedB.ok && verifiedB.claims.userId).toBe(userB.id);
  });

  it('lets an admin obtain a token for any file without an explicit grant', async () => {
    const { mediaFileId } = await createLibraryWithFile();

    const response = await postToken(mediaFileId, admin.accessToken);

    expect(response.statusCode).toBe(200);
    const verified = verifyStreamToken(response.json<TokenBody>().token, streamTokenSecret);
    expect(verified.ok && verified.claims.mediaFileId).toBe(mediaFileId);
  });

  it('rejects invalid bodies with 400 VALIDATION', async () => {
    const user = await registerUser();
    for (const mediaFileId of [undefined, 123, '', null]) {
      const response = await postToken(mediaFileId, user.accessToken);
      expect(response.statusCode, JSON.stringify(mediaFileId)).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
    }
  });
});

describe('POST /api/stream/token enumeration cloak', () => {
  it('returns byte-identical 404s for an ungranted file and a nonexistent file', async () => {
    const user = await registerUser();
    const { mediaFileId } = await createLibraryWithFile(); // never granted to user

    const ungranted = await postToken(mediaFileId, user.accessToken);
    const nonexistent = await postToken('no-such-media-file', user.accessToken);

    expect(ungranted.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    // Byte-identical bodies: nothing distinguishes "exists but not yours"
    // from "does not exist", so ids cannot be enumerated.
    expect(ungranted.body).toBe(nonexistent.body);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('stops issuing tokens the moment a grant is revoked', async () => {
    const user = await registerUser();
    const { libraryId, mediaFileId } = await createLibraryWithFile();
    await grantAccess(user.id, libraryId);
    expect((await postToken(mediaFileId, user.accessToken)).statusCode).toBe(200);

    await prisma.libraryAccess.deleteMany({ where: { userId: user.id, libraryId } });

    const response = await postToken(mediaFileId, user.accessToken);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});
