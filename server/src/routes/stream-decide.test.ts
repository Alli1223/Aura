import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { secretsFilePath } from '../lib/secrets.js';
import { verifyStreamToken } from '../streaming/stream-tokens.js';

// Integration tests for POST /api/stream/decide/:mediaFileId against a real
// temporary SQLite database, CONFIG_DIR and media root. MediaFile + MediaStream
// rows are seeded straight through prisma (no ffmpeg / no scanner). For the
// direct-play branch a real file is written under the media root so the URL the
// decision hands back is exercised end-to-end (fs only, still no ffmpeg).

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let configDir: string;
let mediaRoot: string;
let moviesDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let streamTokenSecret: string;

interface Session {
  id: string;
  accessToken: string;
}
interface Fixture {
  libraryId: string;
  mediaItemId: string;
  mediaFileId: string;
  filePath: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface DirectBody {
  action: 'direct';
  reasons: string[];
  streamToken: string;
  expiresAt: string;
  url: string;
}
interface TranscodeBody {
  action: 'transcode';
  reasons: string[];
  transcodeReason: string;
  transcodeReasons: string[];
  quality: string;
  streamToken: string;
  expiresAt: string;
  hlsStartUrl: string;
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

interface FileSpec {
  container?: string | null;
  videoCodec?: string | null;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  audioCodecs?: string[];
  /** When true, a real byte file is written under the media root. */
  onDisk?: boolean;
}

async function createFile(spec: FileSpec = {}): Promise<Fixture> {
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title: 'Test Movie', sortTitle: 'test movie' },
  });

  const filePath = spec.onDisk
    ? path.join(moviesDir, `${randomUUID().slice(0, 8)}.mp4`)
    : `/media/movies/${randomUUID()}.mkv`;
  if (spec.onDisk) await writeFile(filePath, Buffer.from('deterministic-bytes-for-range-serving'));

  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId: item.id,
      path: filePath,
      size: BigInt(64),
      mtimeMs: BigInt(Date.now()),
      container: spec.container === undefined ? 'mov,mp4,m4a,3gp,3g2,mj2' : spec.container,
      videoCodec: spec.videoCodec === undefined ? 'h264' : spec.videoCodec,
      width: spec.width === undefined ? 1920 : spec.width,
      height: spec.height === undefined ? 1080 : spec.height,
      bitrate: spec.bitrate === undefined ? 4_000_000 : spec.bitrate,
    },
  });

  const audioCodecs = spec.audioCodecs ?? ['aac'];
  const streamRows = [
    { mediaFileId: file.id, streamIndex: 0, type: 'video', codec: spec.videoCodec ?? 'h264' },
    ...audioCodecs.map((codec, i) => ({
      mediaFileId: file.id,
      streamIndex: i + 1,
      type: 'audio',
      codec,
    })),
  ];
  await prisma.mediaStream.createMany({ data: streamRows });

  return { libraryId: library.id, mediaItemId: item.id, mediaFileId: file.id, filePath };
}

function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

function postDecide(
  mediaFileId: string,
  body: Record<string, unknown>,
  accessToken?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/stream/decide/${mediaFileId}`,
    headers: accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
    payload: body,
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-decide-test-'));
  configDir = path.join(tempDir, 'config');
  mediaRoot = path.join(tempDir, 'media');
  moviesDir = path.join(mediaRoot, 'movies');
  await mkdir(moviesDir, { recursive: true });

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = configDir;
  process.env.MEDIA_ROOTS = mediaRoot;
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  await registerUser(); // first registered user becomes admin

  const secrets = JSON.parse(await readFile(secretsFilePath(configDir), 'utf8')) as {
    streamTokenSecret: string;
  };
  streamTokenSecret = secrets.streamTokenSecret;
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('POST /api/stream/decide/:mediaFileId — auth', () => {
  it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
    const fixture = await createFile();
    const response = await postDecide(fixture.mediaFileId, {});
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });

  it('cloaks an ungranted file and a missing id behind byte-identical 404s', async () => {
    const user = await registerUser(); // no grants
    const fixture = await createFile();

    const ungranted = await postDecide(fixture.mediaFileId, {}, user.accessToken);
    const missing = await postDecide('no-such-media-file', {}, user.accessToken);

    expect(ungranted.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(ungranted.body).toBe(missing.body);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('stops deciding the moment a grant is revoked', async () => {
    const user = await registerUser();
    const fixture = await createFile();
    await grantAccess(user.id, fixture.libraryId);
    expect((await postDecide(fixture.mediaFileId, {}, user.accessToken)).statusCode).toBe(200);

    await prisma.libraryAccess.deleteMany({
      where: { userId: user.id, libraryId: fixture.libraryId },
    });
    const after = await postDecide(fixture.mediaFileId, {}, user.accessToken);
    expect(after.statusCode).toBe(404);
  });

  it('rejects an invalid capability body with 400 VALIDATION', async () => {
    const user = await registerUser();
    const fixture = await createFile();
    await grantAccess(user.id, fixture.libraryId);

    const response = await postDecide(fixture.mediaFileId, { maxWidth: -1 }, user.accessToken);
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('POST /api/stream/decide/:mediaFileId — direct branch', () => {
  it('returns a direct decision with a working URL and a token scoped to user+file', async () => {
    const user = await registerUser();
    const fixture = await createFile({ onDisk: true });
    await grantAccess(user.id, fixture.libraryId);

    const response = await postDecide(fixture.mediaFileId, {}, user.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<DirectBody>();

    expect(body.action).toBe('direct');
    expect(body).not.toHaveProperty('quality');
    expect(body).not.toHaveProperty('hlsStartUrl');
    expect(body.reasons.length).toBeGreaterThan(0);
    expect(body.url).toBe(
      `/api/stream/direct/${fixture.mediaFileId}?token=${encodeURIComponent(body.streamToken)}`,
    );

    // The minted token verifies for exactly this user + file.
    const verified = verifyStreamToken(body.streamToken, streamTokenSecret);
    expect(verified.ok && verified.claims.userId).toBe(user.id);
    expect(verified.ok && verified.claims.mediaFileId).toBe(fixture.mediaFileId);

    // And the URL it handed back actually serves bytes (fs only, no ffmpeg).
    const played = await app.inject({ method: 'GET', url: body.url });
    expect(played.statusCode).toBe(200);
    expect(played.rawPayload.length).toBeGreaterThan(0);
  });

  it('applies the conservative browser profile when the body is empty', async () => {
    const user = await registerUser();
    // hevc video would fail the browser profile even though everything else fits.
    const fixture = await createFile({ videoCodec: 'hevc', audioCodecs: ['aac'] });
    await grantAccess(user.id, fixture.libraryId);

    const response = await postDecide(fixture.mediaFileId, {}, user.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json<TranscodeBody>().action).toBe('transcode');
    expect(response.json<TranscodeBody>().transcodeReason).toBe('video-codec');
  });
});

describe('POST /api/stream/decide/:mediaFileId — transcode branch', () => {
  it('returns a transcode decision with a quality-carrying HLS start URL', async () => {
    const user = await registerUser();
    const fixture = await createFile({
      container: 'matroska,webm',
      videoCodec: 'hevc',
      width: 3840,
      height: 2160,
      audioCodecs: ['ac3'],
    });
    await grantAccess(user.id, fixture.libraryId);

    const response = await postDecide(fixture.mediaFileId, {}, user.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<TranscodeBody>();

    expect(body.action).toBe('transcode');
    expect(body).not.toHaveProperty('url');
    expect(body.transcodeReason).toBe('container'); // highest-precedence failure
    expect(body.transcodeReasons).toContain('video-codec');
    expect(body.quality).toBe('1080p'); // 4K source capped to the 1080p client
    expect(body.hlsStartUrl).toBe(
      `/api/stream/hls/${fixture.mediaFileId}?token=${encodeURIComponent(body.streamToken)}&quality=1080p`,
    );

    const verified = verifyStreamToken(body.streamToken, streamTokenSecret);
    expect(verified.ok && verified.claims.userId).toBe(user.id);
    expect(verified.ok && verified.claims.mediaFileId).toBe(fixture.mediaFileId);
  });

  it('never returns a quality above a capped user\'s effective maximum', async () => {
    const user = await registerUser();
    // Cap this user at 480p. The 4K source below would otherwise decide 1080p.
    await prisma.user.update({ where: { id: user.id }, data: { maxQuality: '480p' } });
    const fixture = await createFile({ width: 3840, height: 2160 });
    await grantAccess(user.id, fixture.libraryId);

    const response = await postDecide(fixture.mediaFileId, {}, user.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<TranscodeBody>();

    expect(body.action).toBe('transcode');
    expect(body.transcodeReason).toBe('resolution');
    // Clamped from 1080p down to the user's 480p cap — enforced server-side.
    expect(body.quality).toBe('480p');
    expect(body.hlsStartUrl).toContain('&quality=480p');
  });

  it('honours a rich client capability set (mkv/hevc/ac3 client -> direct)', async () => {
    const user = await registerUser();
    const fixture = await createFile({
      container: 'matroska,webm',
      videoCodec: 'hevc',
      width: 1920,
      height: 1080,
      audioCodecs: ['ac3'],
    });
    await grantAccess(user.id, fixture.libraryId);

    const response = await postDecide(
      fixture.mediaFileId,
      {
        containers: ['mkv', 'mp4'],
        videoCodecs: ['h264', 'hevc'],
        audioCodecs: ['aac', 'ac3'],
        maxWidth: 3840,
        maxHeight: 2160,
      },
      user.accessToken,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<DirectBody>().action).toBe('direct');
  });
});
