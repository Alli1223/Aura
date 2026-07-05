import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { secretsFilePath } from '../lib/secrets.js';
import { issueStreamToken } from '../streaming/stream-tokens.js';

// Integration tests for the HLS transcode routes against a real temporary
// SQLite database, CONFIG_DIR, media root and transcode dir. Fixtures point at
// real ffmpeg-generated video (a small clip copied per file) so the session
// manager spawns genuine ffmpeg. Tokens flow through the real issuance endpoint
// where access allows; adversarial tokens are minted out-of-band with the
// server's own secret and must still be rejected/cloaked. ffmpeg is a hard
// project dependency (Docker image + CI both ship it).

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let configDir: string;
let mediaRoot: string;
let moviesDir: string;
let transcodeDir: string;
let baseClip: string;
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
interface StartBody {
  sessionId: string;
  playlistUrl: string;
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

/** Copies the base clip to a unique path and seeds library/item/file rows. */
async function createMovieFixture(fileName: string): Promise<Fixture> {
  const filePath = path.join(moviesDir, `${randomUUID().slice(0, 8)}-${fileName}`);
  await copyFile(baseClip, filePath);

  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title: 'Test Movie', sortTitle: 'test movie' },
  });
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId: item.id,
      path: filePath,
      size: BigInt(1024),
      mtimeMs: BigInt(Date.now()),
    },
  });
  return { libraryId: library.id, mediaItemId: item.id, mediaFileId: file.id, filePath };
}

function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
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

async function grantedFixture(
  fileName: string,
): Promise<{ user: Session; fixture: Fixture; token: string }> {
  const user = await registerUser();
  const fixture = await createMovieFixture(fileName);
  await grantAccess(user.id, fixture.libraryId);
  const token = await tokenViaApi(user, fixture.mediaFileId);
  return { user, fixture, token };
}

function startHls(
  mediaFileId: string,
  token: string | undefined,
  quality?: string,
): Promise<LightMyRequestResponse> {
  const params = new URLSearchParams();
  if (token !== undefined) params.set('token', token);
  if (quality !== undefined) params.set('quality', quality);
  return app.inject({ method: 'POST', url: `/api/stream/hls/${mediaFileId}?${params.toString()}` });
}

/** POST /hls/:mediaFileId and assert it started; returns the parsed body. */
async function startHlsOk(mediaFileId: string, token: string, quality = '480p'): Promise<StartBody> {
  const response = await startHls(mediaFileId, token, quality);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<StartBody>();
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-hls-routes-'));
  configDir = path.join(tempDir, 'config');
  mediaRoot = path.join(tempDir, 'media');
  moviesDir = path.join(mediaRoot, 'movies');
  transcodeDir = path.join(tempDir, 'transcodes');
  await mkdir(moviesDir, { recursive: true });
  await mkdir(transcodeDir, { recursive: true });

  baseClip = path.join(tempDir, 'base-clip.mp4');
  // 5s 480x360 h264 + stereo aac — small, yields >1 segment quickly.
  // prettier-ignore
  await execFileAsync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=480x360:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2', '-shortest',
    baseClip,
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
  // Generous cap + long idle: route tests start many sessions and must not hit
  // the cap or have a session reaped mid-test. The cap test builds its own app.
  process.env.HLS_MAX_SESSIONS = '25';
  process.env.HLS_SESSION_IDLE_MS = '600000';
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  // The transcode scratch dir is a server setting; point it at the temp dir.
  const admin = await registerUser(); // first registered user becomes admin
  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: { transcodeDir },
  });
  expect(patch.statusCode).toBe(200);

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

describe('POST /api/stream/hls/:mediaFileId — auth', () => {
  it('rejects a missing token with 401 TOKEN_INVALID', async () => {
    const { fixture } = await grantedFixture('a.mp4');
    const response = await startHls(fixture.mediaFileId, undefined);
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects garbage and expired tokens with 401', async () => {
    const { user, fixture } = await grantedFixture('b.mp4');
    const expired = mintToken(user.id, fixture.mediaFileId, -1_000);
    for (const token of ['garbage', 'a.b.c', expired]) {
      const response = await startHls(fixture.mediaFileId, token);
      expect(response.statusCode, token).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
    }
  });

  it('rejects a token scoped to a different media file with 401', async () => {
    const { user, fixture } = await grantedFixture('c.mp4');
    const other = await createMovieFixture('c-other.mp4');
    await grantAccess(user.id, other.libraryId);
    const tokenForFirst = await tokenViaApi(user, fixture.mediaFileId);

    const response = await startHls(other.mediaFileId, tokenForFirst);
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('cloaks an ungranted file behind a 404 identical to a nonexistent id', async () => {
    const user = await registerUser(); // no grants
    const fixture = await createMovieFixture('d.mp4');

    const ungranted = await startHls(fixture.mediaFileId, mintToken(user.id, fixture.mediaFileId));
    const nonexistent = await startHls('no-such-file', mintToken(user.id, 'no-such-file'));

    expect(ungranted.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(ungranted.body).toBe(nonexistent.body);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('stops issuing sessions the moment a grant is revoked (use-time re-check)', async () => {
    const { user, fixture, token } = await grantedFixture('e.mp4');
    await prisma.libraryAccess.deleteMany({
      where: { userId: user.id, libraryId: fixture.libraryId },
    });
    const response = await startHls(fixture.mediaFileId, token);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('rejects an unsupported quality with 400 VALIDATION', async () => {
    const { fixture, token } = await grantedFixture('f.mp4');
    const response = await startHls(fixture.mediaFileId, token, '4k');
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('POST /api/stream/hls/:mediaFileId — session start', () => {
  it('starts a session and returns a token-carrying playlist URL', async () => {
    const { fixture, token } = await grantedFixture('start.mp4');
    const body = await startHlsOk(fixture.mediaFileId, token);

    expect(body.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.playlistUrl).toBe(
      `/api/stream/hls/${body.sessionId}/index.m3u8?token=${encodeURIComponent(token)}`,
    );

    await app.inject({ method: 'DELETE', url: body.playlistUrl.replace('/index.m3u8', '') });
  }, 60_000);

  it('reuses one session for an identical repeated request', async () => {
    const { fixture, token } = await grantedFixture('dedup.mp4');
    const first = await startHlsOk(fixture.mediaFileId, token);
    const second = await startHlsOk(fixture.mediaFileId, token);
    expect(second.sessionId).toBe(first.sessionId);
  }, 60_000);
});

describe('GET /api/stream/hls/:sessionId/:file — playlist & segments', () => {
  it('serves the playlist and a segment with correct content types and caching', async () => {
    const { fixture, token } = await grantedFixture('serve.mp4');
    const { sessionId, playlistUrl } = await startHlsOk(fixture.mediaFileId, token);

    const playlist = await app.inject({ method: 'GET', url: playlistUrl });
    expect(playlist.statusCode).toBe(200);
    expect(playlist.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(playlist.headers['cache-control']).toBe('no-store');
    expect(playlist.body).toContain('#EXTM3U');

    const segmentName = playlist.body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.endsWith('.ts'));
    expect(segmentName).toBeDefined();

    const segment = await app.inject({
      method: 'GET',
      url: `/api/stream/hls/${sessionId}/${segmentName}?token=${encodeURIComponent(token)}`,
    });
    expect(segment.statusCode).toBe(200);
    expect(segment.headers['content-type']).toBe('video/mp2t');
    expect(segment.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(segment.rawPayload.length).toBeGreaterThan(0);
  }, 60_000);

  it('returns 401 for the playlist without a token', async () => {
    const { fixture, token } = await grantedFixture('serve-noauth.mp4');
    const { sessionId } = await startHlsOk(fixture.mediaFileId, token);
    const response = await app.inject({
      method: 'GET',
      url: `/api/stream/hls/${sessionId}/index.m3u8`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  }, 60_000);

  it('404s an unknown session even with a valid token', async () => {
    // A valid token scoped to a real file the user can access, but no session.
    const { token } = await grantedFixture('unknown-sess.mp4');
    const response = await app.inject({
      method: 'GET',
      url: `/api/stream/hls/${randomUUID()}/index.m3u8?token=${encodeURIComponent(token)}`,
    });
    expect(response.statusCode).toBe(404);
  }, 60_000);

  it('rejects traversal and non-allowlisted filenames without reading a file', async () => {
    const { fixture, token } = await grantedFixture('traversal.mp4');
    const { sessionId } = await startHlsOk(fixture.mediaFileId, token);
    const q = `?token=${encodeURIComponent(token)}`;

    for (const evil of ['..%2f..%2fetc%2fpasswd', 'x.mp4', 'index.m3u8.bak', '..%2fsecret.ts']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/stream/hls/${sessionId}/${evil}${q}`,
      });
      expect([400, 404], evil).toContain(response.statusCode);
    }

    // A nested path is a different (unmatched) route entirely — never a read.
    const nested = await app.inject({
      method: 'GET',
      url: `/api/stream/hls/${sessionId}/foo/bar.ts${q}`,
    });
    expect(nested.statusCode).toBe(404);
  }, 60_000);

  it('stops serving segments once the grant is revoked (use-time re-check)', async () => {
    const { user, fixture, token } = await grantedFixture('revoke-serve.mp4');
    const { playlistUrl } = await startHlsOk(fixture.mediaFileId, token);
    expect((await app.inject({ method: 'GET', url: playlistUrl })).statusCode).toBe(200);

    await prisma.libraryAccess.deleteMany({
      where: { userId: user.id, libraryId: fixture.libraryId },
    });

    const after = await app.inject({ method: 'GET', url: playlistUrl });
    expect(after.statusCode).toBe(404);
  }, 60_000);
});

describe('DELETE /api/stream/hls/:sessionId — stop', () => {
  it('stops a session (204) and is idempotent', async () => {
    const { fixture, token } = await grantedFixture('stop.mp4');
    const { sessionId, playlistUrl } = await startHlsOk(fixture.mediaFileId, token);
    const q = `?token=${encodeURIComponent(token)}`;

    const stop = await app.inject({ method: 'DELETE', url: `/api/stream/hls/${sessionId}${q}` });
    expect(stop.statusCode).toBe(204);

    // The playlist is gone now that the session was stopped and cleaned up.
    const gone = await app.inject({ method: 'GET', url: playlistUrl });
    expect(gone.statusCode).toBe(404);

    // Idempotent: deleting again still 204.
    const again = await app.inject({ method: 'DELETE', url: `/api/stream/hls/${sessionId}${q}` });
    expect(again.statusCode).toBe(204);
  }, 60_000);

  it('rejects a delete without a token with 401', async () => {
    const { fixture, token } = await grantedFixture('stop-noauth.mp4');
    const { sessionId } = await startHlsOk(fixture.mediaFileId, token);
    const response = await app.inject({ method: 'DELETE', url: `/api/stream/hls/${sessionId}` });
    expect(response.statusCode).toBe(401);
  }, 60_000);
});

describe('POST /api/stream/hls — concurrency cap', () => {
  it('rejects a session over the cap with 503 TOO_MANY_SESSIONS', async () => {
    // A dedicated app whose manager caps at a single concurrent session.
    process.env.HLS_MAX_SESSIONS = '1';
    const capApp = buildApp();
    await capApp.ready();
    process.env.HLS_MAX_SESSIONS = '25';

    try {
      const first = await grantedFixture('cap-1.mp4');
      const second = await grantedFixture('cap-2.mp4');

      const started = await capApp.inject({
        method: 'POST',
        url: `/api/stream/hls/${first.fixture.mediaFileId}?token=${encodeURIComponent(first.token)}&quality=480p`,
      });
      expect(started.statusCode, started.body).toBe(200);

      const overCap = await capApp.inject({
        method: 'POST',
        url: `/api/stream/hls/${second.fixture.mediaFileId}?token=${encodeURIComponent(second.token)}&quality=480p`,
      });
      expect(overCap.statusCode).toBe(503);
      expect(overCap.json<ErrorBody>().error.code).toBe('TOO_MANY_SESSIONS');
    } finally {
      await capApp.close();
    }
  }, 90_000);
});
