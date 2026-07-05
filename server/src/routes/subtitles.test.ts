import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { probeFile, type ProbeSubtitleStream } from '../media/ffprobe.js';
import { persistProbe } from '../media/persist-probe.js';
import { issueStreamToken } from '../streaming/stream-tokens.js';

// Integration tests for the subtitle routes against a real temporary SQLite
// database, CONFIG_DIR and media root. Embedded subtitle tracks come from real
// ffmpeg-muxed mkv fixtures; image-based tracks are faked as MediaStream rows
// with a PGS codec (muxing a real PGS is unnecessary — classification is by
// codec). Tokens flow through the real issuance endpoint where access allows;
// adversarial tokens are minted out-of-band with the server's own secret.

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let mediaRoot: string;
let moviesDir: string;
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
  filePath: string;
  /** trackId of the (real) embedded subtitle, when one was muxed. */
  embeddedTrackId?: string;
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

interface FixtureOptions {
  /** Mux a real forced eng srt subtitle track into the video. */
  embedForcedEngSrt?: boolean;
  /** External sidecar files: filename suffix appended to the base + content. */
  sidecars?: { suffix: string; content: string }[];
  /** Add a fake image-based (PGS) subtitle MediaStream row. */
  imageStream?: boolean;
}

async function createFixture(baseName: string, options: FixtureOptions = {}): Promise<Fixture> {
  const filePath = path.join(moviesDir, `${baseName}.mkv`);

  if (options.embedForcedEngSrt) {
    const srtPath = path.join(tempDir, `${baseName}.embed.srt`);
    await writeFile(
      srtPath,
      '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n',
      'utf8',
    );
    // prettier-ignore
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-i', srtPath,
      '-map', '0:v:0', '-map', '1:a:0', '-map', '2:s:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-c:s', 'srt',
      '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
      '-disposition:s:0', 'forced',
      filePath,
    ]);
  } else {
    // prettier-ignore
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      filePath,
    ]);
  }

  for (const sidecar of options.sidecars ?? []) {
    await writeFile(path.join(moviesDir, `${baseName}${sidecar.suffix}`), sidecar.content, 'utf8');
  }

  const stats = await readFile(filePath);
  const library = await prisma.library.create({
    data: { name: `Library ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title: baseName, sortTitle: baseName },
  });
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId: item.id,
      path: filePath,
      size: BigInt(stats.length),
      mtimeMs: BigInt(Date.now()),
    },
  });

  let embeddedTrackId: string | undefined;
  if (options.embedForcedEngSrt) {
    const probe = await probeFile(filePath);
    await persistProbe(file.id, probe);
    const sub = probe.streams.find((s): s is ProbeSubtitleStream => s.type === 'subtitle');
    embeddedTrackId = sub === undefined ? undefined : `embedded-${sub.index}`;
  }
  if (options.imageStream) {
    // A high index that never collides with the real muxed streams (0,1,2).
    await prisma.mediaStream.create({
      data: {
        mediaFileId: file.id,
        streamIndex: 9,
        type: 'subtitle',
        codec: 'hdmv_pgs_subtitle',
        language: 'eng',
        isForced: false,
        isDefault: false,
      },
    });
  }

  return {
    libraryId: library.id,
    mediaItemId: item.id,
    mediaFileId: file.id,
    filePath,
    embeddedTrackId,
  };
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

function listSubs(mediaFileId: string, token: string | undefined): Promise<LightMyRequestResponse> {
  const query = token === undefined ? '' : `?token=${token}`;
  return app.inject({ method: 'GET', url: `/api/stream/subtitles/${mediaFileId}${query}` });
}

function getVtt(
  mediaFileId: string,
  file: string,
  token: string | undefined,
): Promise<LightMyRequestResponse> {
  const query = token === undefined ? '' : `?token=${token}`;
  return app.inject({
    method: 'GET',
    url: `/api/stream/subtitles/${mediaFileId}/${file}${query}`,
  });
}

/** Grants a fresh user access to a fresh fixture and returns both + a token. */
async function granted(
  baseName: string,
  options?: FixtureOptions,
): Promise<{ user: Session; fixture: Fixture; token: string }> {
  const user = await registerUser();
  const fixture = await createFixture(baseName, options);
  await grantAccess(user.id, fixture.libraryId);
  const token = await tokenViaApi(user, fixture.mediaFileId);
  return { user, fixture, token };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-subtitles-route-test-'));
  const configDir = path.join(tempDir, 'config');
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

describe('subtitle list route: authentication', () => {
  it('rejects a missing token with 401 TOKEN_INVALID', async () => {
    const fixture = await createFixture('list-no-token');
    const response = await listSubs(fixture.mediaFileId, undefined);
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects garbage and expired tokens with 401', async () => {
    const user = await registerUser();
    const fixture = await createFixture('list-bad-token');
    await grantAccess(user.id, fixture.libraryId);

    for (const token of ['garbage', 'aaaa.bbbb', 'a.b.c']) {
      const response = await listSubs(fixture.mediaFileId, token);
      expect(response.statusCode, token).toBe(401);
      expect(response.json<ErrorBody>().error.code, token).toBe('TOKEN_INVALID');
    }

    const expired = mintToken(user.id, fixture.mediaFileId, -1_000);
    const expiredResponse = await listSubs(fixture.mediaFileId, expired);
    expect(expiredResponse.statusCode).toBe(401);
    expect(expiredResponse.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token scoped to a different media file with 401', async () => {
    const { user, fixture } = await granted('list-file-a');
    const other = await createFixture('list-file-b');
    await grantAccess(user.id, other.libraryId);
    const tokenForA = await tokenViaApi(user, fixture.mediaFileId);

    const response = await listSubs(other.mediaFileId, tokenForA);
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a deleted user with 401 and a disabled user with 403', async () => {
    const deleted = await granted('list-deleted-user');
    await prisma.user.delete({ where: { id: deleted.user.id } });
    const deletedResponse = await listSubs(deleted.fixture.mediaFileId, deleted.token);
    expect(deletedResponse.statusCode).toBe(401);
    expect(deletedResponse.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');

    const disabled = await granted('list-disabled-user');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/users/${disabled.user.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { isEnabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const disabledResponse = await listSubs(disabled.fixture.mediaFileId, disabled.token);
    expect(disabledResponse.statusCode).toBe(403);
    expect(disabledResponse.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('subtitle list route: access enforcement', () => {
  it('cloaks an ungranted file behind a 404 byte-identical to a nonexistent id', async () => {
    const user = await registerUser(); // no grants
    const fixture = await createFixture('list-ungranted');

    const ungranted = await listSubs(fixture.mediaFileId, mintToken(user.id, fixture.mediaFileId));
    const nonexistent = await listSubs('no-such-file', mintToken(user.id, 'no-such-file'));

    expect(ungranted.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(ungranted.body).toBe(nonexistent.body); // byte-identical
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('stops listing the moment a grant is revoked, even with a live token', async () => {
    const { user, fixture, token } = await granted('list-revoked');
    expect((await listSubs(fixture.mediaFileId, token)).statusCode).toBe(200);

    await prisma.libraryAccess.deleteMany({
      where: { userId: user.id, libraryId: fixture.libraryId },
    });

    const response = await listSubs(fixture.mediaFileId, token);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});

describe('subtitle list route: contents', () => {
  it('lists embedded, external and image tracks with kind classification', async () => {
    const { fixture, token } = await granted('list-tracks', {
      embedForcedEngSrt: true,
      imageStream: true,
      sidecars: [
        { suffix: '.en.srt', content: '1\n00:00:00,000 --> 00:00:01,000\nEN\n' },
        { suffix: '.vtt', content: 'WEBVTT\n\n00:00.000 --> 00:01.000\nVTT\n' },
      ],
    });

    const response = await listSubs(fixture.mediaFileId, token);
    expect(response.statusCode).toBe(200);
    const { tracks } = response.json<{ tracks: { id: string; kind: string; source: string }[] }>();

    // Note: the fixture's real embedded srt is at streamIndex 2; the fake PGS
    // row is at streamIndex 0 — so two embedded tracks plus two sidecars.
    const embedded = tracks.filter((t) => t.source === 'embedded');
    const external = tracks.filter((t) => t.source === 'external');
    expect(embedded.length).toBeGreaterThanOrEqual(2);
    expect(external).toHaveLength(2);
    expect(tracks.some((t) => t.kind === 'image')).toBe(true);
    expect(tracks.some((t) => t.kind === 'text' && t.source === 'external')).toBe(true);
    // No filesystem paths leak into the response.
    expect(response.body).not.toContain(moviesDir);
  });
});

describe('subtitle vtt route', () => {
  it('serves an embedded srt track as text/vtt with a WEBVTT body', async () => {
    const { fixture, token } = await granted('vtt-embedded', { embedForcedEngSrt: true });
    expect(fixture.embeddedTrackId).toBeDefined();

    const response = await getVtt(fixture.mediaFileId, `${fixture.embeddedTrackId}.vtt`, token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(response.headers['cache-control']).toBe('private, max-age=0');
    expect(response.body.startsWith('WEBVTT')).toBe(true);
    expect(response.body).toContain('Hello');
  });

  it('converts an external .srt sidecar to WebVTT', async () => {
    const { fixture, token } = await granted('vtt-external', {
      sidecars: [{ suffix: '.en.srt', content: '1\n00:00:00,000 --> 00:00:02,000\nSidecar\n' }],
    });
    const list = await listSubs(fixture.mediaFileId, token);
    const external = list
      .json<{ tracks: { id: string; source: string }[] }>()
      .tracks.find((t) => t.source === 'external');
    expect(external).toBeDefined();

    const response = await getVtt(fixture.mediaFileId, `${external!.id}.vtt`, token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(response.body.startsWith('WEBVTT')).toBe(true);
    expect(response.body).toContain('Sidecar');
  });

  it('returns 404 for an unknown or malformed track id', async () => {
    const { fixture, token } = await granted('vtt-unknown', { embedForcedEngSrt: true });

    const unknown = await getVtt(fixture.mediaFileId, 'embedded-99.vtt', token);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    const malformed = await getVtt(fixture.mediaFileId, 'not-a-track.txt', token);
    expect(malformed.statusCode).toBe(404);

    // A dotted (non-scheme) track id never matches the strict filename pattern.
    const dotted = await getVtt(fixture.mediaFileId, 'embedded-0.srt.vtt', token);
    expect(dotted.statusCode).toBe(404);
  });

  it('returns a typed 415 (not 500) for an image-based track', async () => {
    const { fixture, token } = await granted('vtt-image', { imageStream: true });
    const list = await listSubs(fixture.mediaFileId, token);
    const image = list
      .json<{ tracks: { id: string; kind: string }[] }>()
      .tracks.find((t) => t.kind === 'image');
    expect(image).toBeDefined();

    const response = await getVtt(fixture.mediaFileId, `${image!.id}.vtt`, token);
    expect(response.statusCode).toBe(415);
    expect(response.json<ErrorBody>().error.code).toBe('IMAGE_SUBTITLE');
  });

  it('rejects a missing token, and denies access after a grant is revoked', async () => {
    const noToken = await createFixture('vtt-no-token', { embedForcedEngSrt: true });
    const missing = await getVtt(noToken.mediaFileId, `${noToken.embeddedTrackId}.vtt`, undefined);
    expect(missing.statusCode).toBe(401);
    expect(missing.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');

    const { user, fixture, token } = await granted('vtt-revoked', { embedForcedEngSrt: true });
    expect(
      (await getVtt(fixture.mediaFileId, `${fixture.embeddedTrackId}.vtt`, token)).statusCode,
    ).toBe(200);
    await prisma.libraryAccess.deleteMany({
      where: { userId: user.id, libraryId: fixture.libraryId },
    });
    const revoked = await getVtt(fixture.mediaFileId, `${fixture.embeddedTrackId}.vtt`, token);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});
