import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { secretsFilePath } from '../lib/secrets.js';
import { issueStreamToken } from '../streaming/stream-tokens.js';

// Integration tests for the trickplay routes against a real temporary SQLite
// database, CONFIG_DIR and media root, with real ffmpeg generating sprites on
// demand. Tokens flow through the real issuance endpoint where access allows;
// adversarial tokens are minted out-of-band with the server's own secret.

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let mediaRoot: string;
let clipPath: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let streamTokenSecret: string;
let admin: Session;

interface Session {
  id: string;
  username: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface Fixture {
  libraryId: string;
  mediaItemId: string;
  mediaFileId: string;
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, ['-y', '-v', 'error', ...args]);
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
  return { id: body.user.id, username, accessToken: body.accessToken };
}

function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

/**
 * A media item + file backed by a unique copy of the master clip (MediaFile.path
 * is unique, so every fixture needs its own on-disk file), with known dimensions.
 */
async function createFixture(): Promise<Fixture> {
  const filePath = path.join(mediaRoot, `clip-${randomUUID().slice(0, 12)}.mp4`);
  await copyFile(clipPath, filePath);
  const stats = await stat(filePath);

  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title: 'Clip', sortTitle: 'Clip' },
  });
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId: item.id,
      path: filePath,
      size: BigInt(stats.size),
      mtimeMs: BigInt(Math.round(stats.mtimeMs)),
      width: 640,
      height: 360,
      durationMs: 20_000,
    },
  });
  return { libraryId: library.id, mediaItemId: item.id, mediaFileId: file.id };
}

async function tokenViaApi(session: Session, mediaFileId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/stream/token',
    headers: { authorization: `Bearer ${session.accessToken}` },
    payload: { mediaFileId },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>().token;
}

function mintToken(userId: string, mediaFileId: string, ttlMs?: number): string {
  return issueStreamToken({ userId, mediaFileId, secret: streamTokenSecret, ttlMs }).token;
}

function getManifest(mediaFileId: string, token: string | undefined): Promise<LightMyRequestResponse> {
  const query = token === undefined ? '' : `?token=${token}`;
  return app.inject({ method: 'GET', url: `/api/stream/trickplay/${mediaFileId}/manifest${query}` });
}

function getSprite(
  mediaFileId: string,
  sprite: string,
  token: string | undefined,
): Promise<LightMyRequestResponse> {
  const query = token === undefined ? '' : `?token=${token}`;
  return app.inject({
    method: 'GET',
    url: `/api/stream/trickplay/${mediaFileId}/${sprite}${query}`,
  });
}

/** Grants a fresh user access to a fresh fixture and returns both + a token. */
async function granted(): Promise<{ user: Session; fixture: Fixture; token: string }> {
  const user = await registerUser();
  const fixture = await createFixture();
  await grantAccess(user.id, fixture.libraryId);
  const token = await tokenViaApi(user, fixture.mediaFileId);
  return { user, fixture, token };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-trickplay-route-test-'));
  const configDir = path.join(tempDir, 'config');
  mediaRoot = path.join(tempDir, 'media');
  await mkdir(mediaRoot, { recursive: true });

  clipPath = path.join(mediaRoot, 'clip.mp4');
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=20:size=640x360:rate=15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    clipPath,
  ]);

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = configDir;
  process.env.MEDIA_ROOTS = mediaRoot;
  process.env.TRICKPLAY_ENABLED = 'true';
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
  delete process.env.TRICKPLAY_ENABLED;
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('trickplay manifest route: authentication', () => {
  it('rejects a missing token with 401 TOKEN_INVALID', async () => {
    const fixture = await createFixture();
    const response = await getManifest(fixture.mediaFileId, undefined);
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects garbage and expired tokens with 401', async () => {
    const user = await registerUser();
    const fixture = await createFixture();
    await grantAccess(user.id, fixture.libraryId);

    for (const token of ['garbage', 'aaaa.bbbb', 'a.b.c']) {
      const response = await getManifest(fixture.mediaFileId, token);
      expect(response.statusCode, token).toBe(401);
    }
    const expired = mintToken(user.id, fixture.mediaFileId, -1_000);
    expect((await getManifest(fixture.mediaFileId, expired)).statusCode).toBe(401);
  });

  it('rejects a token scoped to a different media file with 401', async () => {
    const { user, fixture } = await granted();
    const other = await createFixture();
    await grantAccess(user.id, other.libraryId);
    const tokenForFixture = await tokenViaApi(user, fixture.mediaFileId);

    const response = await getManifest(other.mediaFileId, tokenForFixture);
    expect(response.statusCode).toBe(401);
  });

  it('rejects a deleted user with 401 and a disabled user with 403', async () => {
    const deleted = await granted();
    await prisma.user.delete({ where: { id: deleted.user.id } });
    expect((await getManifest(deleted.fixture.mediaFileId, deleted.token)).statusCode).toBe(401);

    const disabled = await granted();
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/users/${disabled.user.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { isEnabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const response = await getManifest(disabled.fixture.mediaFileId, disabled.token);
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('trickplay manifest route: access enforcement', () => {
  it('cloaks an ungranted file behind a 404 byte-identical to a nonexistent id', async () => {
    const user = await registerUser(); // no grants
    const fixture = await createFixture();

    const ungranted = await getManifest(fixture.mediaFileId, mintToken(user.id, fixture.mediaFileId));
    const nonexistent = await getManifest('no-such-file', mintToken(user.id, 'no-such-file'));

    expect(ungranted.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(ungranted.body).toBe(nonexistent.body); // byte-identical
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('stops serving the moment a grant is revoked, even with a live token', async () => {
    const { user, fixture, token } = await granted();
    expect((await getManifest(fixture.mediaFileId, token)).statusCode).toBe(200);

    await prisma.libraryAccess.deleteMany({
      where: { userId: user.id, libraryId: fixture.libraryId },
    });
    expect((await getManifest(fixture.mediaFileId, token)).statusCode).toBe(404);
  });
});

describe('trickplay manifest route: contents', () => {
  it('generates the sprites on demand and returns the manifest as JSON', async () => {
    const { fixture, token } = await granted();
    const response = await getManifest(fixture.mediaFileId, token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('private, max-age=0');

    const manifest = response.json<{
      thumbnailCount: number;
      intervalSec: number;
      sheets: string[];
    }>();
    expect(manifest.thumbnailCount).toBe(2);
    expect(manifest.intervalSec).toBe(10);
    expect(manifest.sheets).toEqual(['sprite-0.jpg']);

    // No filesystem path leaks into the response.
    expect(response.body).not.toContain(mediaRoot);
  });
});

describe('trickplay sprite route', () => {
  it('serves a generated sprite sheet as image/jpeg', async () => {
    const { fixture, token } = await granted();
    // The manifest request generates the sprites the sheet route then serves.
    const manifest = await getManifest(fixture.mediaFileId, token);
    const sheet = manifest.json<{ sheets: string[] }>().sheets[0]!;

    const response = await getSprite(fixture.mediaFileId, sheet, token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    const bytes = response.rawPayload;
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it('returns 404 for an unknown or malformed sprite name', async () => {
    const { fixture, token } = await granted();
    await getManifest(fixture.mediaFileId, token); // generate first

    expect((await getSprite(fixture.mediaFileId, 'sprite-99.jpg', token)).statusCode).toBe(404);
    expect((await getSprite(fixture.mediaFileId, 'manifest.json', token)).statusCode).toBe(404);
    expect((await getSprite(fixture.mediaFileId, 'sprite-0.png', token)).statusCode).toBe(404);
  });

  it('requires a valid token', async () => {
    const fixture = await createFixture();
    expect((await getSprite(fixture.mediaFileId, 'sprite-0.jpg', undefined)).statusCode).toBe(401);
  });
});
