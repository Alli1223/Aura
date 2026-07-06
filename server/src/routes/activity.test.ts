import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { secretsFilePath } from '../lib/secrets.js';
import { issueStreamToken } from '../streaming/stream-tokens.js';

// Integration tests for the admin activity dashboard routes against a real
// temporary SQLite DB, CONFIG_DIR, media root and transcode dir. Live sessions
// are created by starting a REAL transcode through the stream plugin, which
// shares one HlsSessionManager with the activity plugin (the manager-instance
// refactor) — so what the activity routes list/kill is exactly what streaming
// started. ffmpeg is a hard project dependency (Docker image + CI both ship it).

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
let admin: Session;
let streamTokenSecret: string;

interface Session {
  id: string;
  username: string;
  accessToken: string;
  role: string;
}
interface Fixture {
  libraryId: string;
  mediaItemId: string;
  mediaFileId: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface ActivitySession {
  id: string;
  userId: string;
  username: string | null;
  mediaFileId: string;
  mediaItemId: string | null;
  title: string | null;
  itemType: string | null;
  quality: string;
  audioTrackIndex: number;
  downmixStereo: boolean;
  startOffsetSec: number;
  burnSubtitleTrackId: string | null;
  transcode: boolean;
  burningSubtitle: boolean;
  createdAt: string;
  lastAccess: string;
  state: string;
}

async function registerUser(): Promise<Session> {
  const username = `user-${randomUUID().slice(0, 18)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string; role: string }; accessToken: string }>();
  return { id: body.user.id, username, accessToken: body.accessToken, role: body.user.role };
}

/** Copies the base clip to a unique path and seeds library/item/file rows. */
async function createMovieFixture(title: string): Promise<Fixture> {
  const filePath = path.join(moviesDir, `${randomUUID().slice(0, 8)}.mp4`);
  await copyFile(baseClip, filePath);

  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title, sortTitle: title.toLowerCase() },
  });
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId: item.id,
      path: filePath,
      size: BigInt(1024),
      mtimeMs: BigInt(Date.now()),
    },
  });
  return { libraryId: library.id, mediaItemId: item.id, mediaFileId: file.id };
}

function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

function mintToken(userId: string, mediaFileId: string): string {
  return issueStreamToken({ userId, mediaFileId, secret: streamTokenSecret }).token;
}

/** Registers a viewer, seeds a movie, grants access and starts a real transcode. */
async function startLiveSession(
  title = 'Test Movie',
): Promise<{ sessionId: string; viewer: Session; fixture: Fixture }> {
  const viewer = await registerUser();
  const fixture = await createMovieFixture(title);
  await grantAccess(viewer.id, fixture.libraryId);
  const token = mintToken(viewer.id, fixture.mediaFileId);
  const start = await app.inject({
    method: 'POST',
    url: `/api/stream/hls/${fixture.mediaFileId}?token=${encodeURIComponent(token)}&quality=480p`,
  });
  expect(start.statusCode, start.body).toBe(200);
  const sessionId = start.json<{ sessionId: string }>().sessionId;
  return { sessionId, viewer, fixture };
}

function listSessions(accessToken?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/activity/sessions',
    headers: accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

function killSession(sessionId: string, accessToken?: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/activity/sessions/${sessionId}`,
    headers: accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-activity-'));
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
  process.env.HLS_MAX_SESSIONS = '25';
  process.env.HLS_SESSION_IDLE_MS = '600000';
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  // The first registered user becomes admin; point the scratch dir at the temp.
  admin = await registerUser();
  expect(admin.role).toBe('admin');
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

describe('GET /api/activity/sessions — auth', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const response = await listSessions();
    expect(response.statusCode).toBe(401);
  });

  it('rejects a non-admin user with 403', async () => {
    const user = await registerUser(); // second+ registration => role "user"
    expect(user.role).toBe('user');
    const response = await listSessions(user.accessToken);
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it('returns a sessions array for an admin', async () => {
    const response = await listSessions(admin.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(Array.isArray(response.json<{ sessions: ActivitySession[] }>().sessions)).toBe(true);
  });
});

describe('GET /api/activity/sessions — enrichment', () => {
  it('lists a live transcode session enriched with username, title and type', async () => {
    const { sessionId, viewer } = await startLiveSession('Enriched Movie');

    const response = await listSessions(admin.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    const sessions = response.json<{ sessions: ActivitySession[] }>().sessions;
    const session = sessions.find((entry) => entry.id === sessionId);
    expect(session, 'expected the started session to be listed').toBeDefined();

    expect(session).toMatchObject({
      id: sessionId,
      userId: viewer.id,
      username: viewer.username,
      title: 'Enriched Movie',
      itemType: 'movie',
      quality: '480p',
      transcode: true,
      burningSubtitle: false,
      burnSubtitleTrackId: null,
      startOffsetSec: 0,
    });
    expect(['starting', 'ready']).toContain(session!.state);
    // ISO timestamps, not epoch numbers.
    expect(new Date(session!.createdAt).toISOString()).toBe(session!.createdAt);
    expect(new Date(session!.lastAccess).toISOString()).toBe(session!.lastAccess);

    await killSession(sessionId, admin.accessToken);
  }, 60_000);
});

describe('DELETE /api/activity/sessions/:id', () => {
  it('kills a live session (204), cleans its dir, and audits the kill', async () => {
    const { sessionId } = await startLiveSession();
    expect(existsSync(path.join(transcodeDir, sessionId))).toBe(true);

    const killed = await killSession(sessionId, admin.accessToken);
    expect(killed.statusCode, killed.body).toBe(204);

    // The manager stopped it: gone from the list and its scratch dir removed.
    const after = await listSessions(admin.accessToken);
    const stillListed = after
      .json<{ sessions: ActivitySession[] }>()
      .sessions.some((entry) => entry.id === sessionId);
    expect(stillListed).toBe(false);
    expect(existsSync(path.join(transcodeDir, sessionId))).toBe(false);

    // Audit row written for the kill, attributed to the admin.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'activity.session_killed', targetId: sessionId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(admin.id);
    expect(audit?.targetType).toBe('hls_session');

    // Idempotent: a repeat kill of the same (now-stopped) session is still 204.
    const again = await killSession(sessionId, admin.accessToken);
    expect(again.statusCode).toBe(204);
  }, 60_000);

  it('returns 404 for an unknown session id', async () => {
    const response = await killSession(randomUUID(), admin.accessToken);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('rejects an unauthenticated kill with 401 and a non-admin with 403', async () => {
    const { sessionId } = await startLiveSession();

    const noAuth = await killSession(sessionId);
    expect(noAuth.statusCode).toBe(401);

    const user = await registerUser();
    const forbidden = await killSession(sessionId, user.accessToken);
    expect(forbidden.statusCode).toBe(403);

    // The session survived the rejected kills — an admin can still stop it.
    expect(existsSync(path.join(transcodeDir, sessionId))).toBe(true);
    const ok = await killSession(sessionId, admin.accessToken);
    expect(ok.statusCode).toBe(204);
  }, 60_000);
});
