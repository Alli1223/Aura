import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
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

// Integration tests for GET/HEAD /api/stream/direct/:mediaFileId against a
// real temporary SQLite database, CONFIG_DIR and media root. Fixture files
// are real files with known deterministic bytes (content does not need to be
// valid video for range semantics), plus one genuine ffmpeg-generated mp4 as
// an end-to-end sanity check. Tokens flow through the real issuance endpoint
// where the scenario allows; adversarial tokens (expired, wrong file,
// ungranted) are minted out-of-band with the server's own secret, which the
// endpoint must still reject or cloak.

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let mediaRoot: string;
let moviesDir: string;
let outsideDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let streamTokenSecret: string;
let admin: Session; // first registered user

interface Session {
  id: string;
  username: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

/** Deterministic, non-repeating-looking bytes so slices are distinguishable. */
function fixtureBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
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

interface Fixture {
  libraryId: string;
  mediaItemId: string;
  mediaFileId: string;
  filePath: string;
  content: Buffer;
}

/** Writes a real file into the media root and seeds library/item/file rows. */
async function createMovieFixture(
  fileName: string,
  content: Buffer = fixtureBytes(1024),
): Promise<Fixture> {
  const filePath = path.join(moviesDir, fileName);
  await writeFile(filePath, content);

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
      size: BigInt(content.length),
      mtimeMs: BigInt(Date.now()),
    },
  });
  return {
    libraryId: library.id,
    mediaItemId: item.id,
    mediaFileId: file.id,
    filePath,
    content,
  };
}

function grantAccess(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

/** Streaming token via the real issuance endpoint (requires access). */
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

/** Streaming token minted out-of-band (bypasses issuance-time checks). */
function mintToken(userId: string, mediaFileId: string, ttlMs?: number): string {
  return issueStreamToken({ userId, mediaFileId, secret: streamTokenSecret, ttlMs }).token;
}

function requestDirect(
  method: 'GET' | 'HEAD',
  mediaFileId: string,
  token: string | undefined,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const query = token === undefined ? '' : `?token=${token}`;
  return app.inject({ method, url: `/api/stream/direct/${mediaFileId}${query}`, headers });
}

/** Grants a fresh user access to a fresh fixture and returns both + token. */
async function grantedFixture(
  fileName: string,
  content?: Buffer,
): Promise<{ user: Session; fixture: Fixture; token: string }> {
  const user = await registerUser();
  const fixture = await createMovieFixture(fileName, content);
  await grantAccess(user.id, fixture.libraryId);
  const token = await tokenViaApi(user, fixture.mediaFileId);
  return { user, fixture, token };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-direct-play-test-'));
  const configDir = path.join(tempDir, 'config');
  mediaRoot = path.join(tempDir, 'media');
  moviesDir = path.join(mediaRoot, 'movies');
  outsideDir = path.join(tempDir, 'outside');
  await mkdir(moviesDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

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

describe('direct play: full responses and headers', () => {
  it('serves the exact file bytes with 200 and byte-serving headers', async () => {
    const { fixture, token } = await grantedFixture('full-body.mp4');

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(fixture.content)).toBe(true);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['content-length']).toBe(String(fixture.content.length));
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['cache-control']).toBe('private, max-age=0');
    expect(response.headers['content-disposition']).toBe(
      `inline; filename="full-body.mp4"; filename*=UTF-8''full-body.mp4`,
    );
    expect(response.headers.etag).toMatch(/^W\/"\d+-\d+"$/);
    expect(response.headers['last-modified']).toBeDefined();
    // Last-Modified must parse back to a real date near now.
    const lastModified = Date.parse(response.headers['last-modified'] as string);
    expect(Number.isNaN(lastModified)).toBe(false);
    expect(Math.abs(Date.now() - lastModified)).toBeLessThan(5 * 60_000);
  });

  it.each([
    ['content-type.mkv', 'video/x-matroska'],
    ['content-type.webm', 'video/webm'],
    ['content-type.avi', 'video/x-msvideo'],
    ['content-type.ogv', 'video/ogg'],
    ['content-type.unknownext', 'application/octet-stream'],
  ])('maps %s to Content-Type %s', async (fileName, expected) => {
    const { fixture, token } = await grantedFixture(fileName);

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(expected);
  });

  it('ignores a malformed Range header and serves the full file', async () => {
    const { fixture, token } = await grantedFixture('malformed-range.mp4');

    for (const range of ['bytes=oops', 'bytes=500-100', 'chunks=0-5']) {
      const response = await requestDirect('GET', fixture.mediaFileId, token, { range });
      expect(response.statusCode, range).toBe(200);
      expect(response.rawPayload.equals(fixture.content), range).toBe(true);
    }
  });
});

describe('direct play: range requests', () => {
  it('serves an exact bounded slice with 206 and Content-Range', async () => {
    const { fixture, token } = await grantedFixture('bounded.mp4');

    const response = await requestDirect('GET', fixture.mediaFileId, token, {
      range: 'bytes=100-199',
    });

    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.equals(fixture.content.subarray(100, 200))).toBe(true);
    expect(response.headers['content-range']).toBe('bytes 100-199/1024');
    expect(response.headers['content-length']).toBe('100');
    expect(response.headers['accept-ranges']).toBe('bytes');
  });

  it('serves an open-ended range to EOF', async () => {
    const { fixture, token } = await grantedFixture('open-ended.mp4');

    const response = await requestDirect('GET', fixture.mediaFileId, token, {
      range: 'bytes=900-',
    });

    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.equals(fixture.content.subarray(900))).toBe(true);
    expect(response.headers['content-range']).toBe('bytes 900-1023/1024');
    expect(response.headers['content-length']).toBe('124');
  });

  it('serves a suffix range of the final N bytes', async () => {
    const { fixture, token } = await grantedFixture('suffix.mp4');

    const response = await requestDirect('GET', fixture.mediaFileId, token, {
      range: 'bytes=-100',
    });

    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.equals(fixture.content.subarray(924))).toBe(true);
    expect(response.headers['content-range']).toBe('bytes 924-1023/1024');
  });

  it('serves the whole file as 206 for a suffix longer than the file', async () => {
    const { fixture, token } = await grantedFixture('long-suffix.mp4');

    const response = await requestDirect('GET', fixture.mediaFileId, token, {
      range: 'bytes=-999999',
    });

    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.equals(fixture.content)).toBe(true);
    expect(response.headers['content-range']).toBe('bytes 0-1023/1024');
  });

  it('serves only the first range of a multi-range request', async () => {
    const { fixture, token } = await grantedFixture('multi-range.mp4');

    const response = await requestDirect('GET', fixture.mediaFileId, token, {
      range: 'bytes=0-49,500-599',
    });

    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.equals(fixture.content.subarray(0, 50))).toBe(true);
    expect(response.headers['content-range']).toBe('bytes 0-49/1024');
    expect(response.headers['content-type']).toBe('video/mp4'); // single-part, not multipart
  });

  it('responds 416 with Content-Range bytes */size when the range is unsatisfiable', async () => {
    const { fixture, token } = await grantedFixture('unsatisfiable.mp4');

    for (const range of ['bytes=1024-', 'bytes=5000-6000', 'bytes=-0']) {
      const response = await requestDirect('GET', fixture.mediaFileId, token, { range });
      expect(response.statusCode, range).toBe(416);
      expect(response.headers['content-range'], range).toBe('bytes */1024');
      expect(response.json<ErrorBody>().error.code, range).toBe('RANGE_NOT_SATISFIABLE');
    }
  });
});

describe('direct play: HEAD and conditional requests', () => {
  it('answers HEAD with the same headers as GET and no body', async () => {
    const { fixture, token } = await grantedFixture('head.mp4');

    const get = await requestDirect('GET', fixture.mediaFileId, token);
    const head = await requestDirect('HEAD', fixture.mediaFileId, token);

    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);
    for (const header of [
      'content-type',
      'content-length',
      'content-disposition',
      'accept-ranges',
      'cache-control',
      'etag',
      'last-modified',
    ]) {
      expect(head.headers[header], header).toEqual(get.headers[header]);
    }
  });

  it('answers a ranged HEAD with 206 headers and no body', async () => {
    const { fixture, token } = await grantedFixture('head-range.mp4');

    const head = await requestDirect('HEAD', fixture.mediaFileId, token, {
      range: 'bytes=100-199',
    });

    expect(head.statusCode).toBe(206);
    expect(head.rawPayload.length).toBe(0);
    expect(head.headers['content-range']).toBe('bytes 100-199/1024');
    expect(head.headers['content-length']).toBe('100');
  });

  it('answers 304 with no body when If-None-Match matches', async () => {
    const { fixture, token } = await grantedFixture('etag.mp4');

    const first = await requestDirect('GET', fixture.mediaFileId, token);
    const etag = first.headers.etag as string;

    const revalidation = await requestDirect('GET', fixture.mediaFileId, token, {
      'if-none-match': etag,
    });
    expect(revalidation.statusCode).toBe(304);
    expect(revalidation.rawPayload.length).toBe(0);
    expect(revalidation.headers.etag).toBe(etag);

    const changed = await requestDirect('GET', fixture.mediaFileId, token, {
      'if-none-match': 'W/"something-else"',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.rawPayload.equals(fixture.content)).toBe(true);
  });
});

describe('direct play: token authentication', () => {
  it('rejects a missing token with 401 TOKEN_INVALID', async () => {
    const { fixture } = await grantedFixture('no-token.mp4');

    const response = await requestDirect('GET', fixture.mediaFileId, undefined);

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects garbage tokens with 401 TOKEN_INVALID', async () => {
    const { fixture } = await grantedFixture('garbage-token.mp4');

    for (const token of ['garbage', 'aaaa.bbbb', 'a.b.c']) {
      const response = await requestDirect('GET', fixture.mediaFileId, token);
      expect(response.statusCode, token).toBe(401);
      expect(response.json<ErrorBody>().error.code, token).toBe('TOKEN_INVALID');
    }
  });

  it('rejects an expired token with 401 TOKEN_INVALID', async () => {
    const { user, fixture } = await grantedFixture('expired-token.mp4');
    const expired = mintToken(user.id, fixture.mediaFileId, -1_000);

    const response = await requestDirect('GET', fixture.mediaFileId, expired);

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token scoped to a different media file with 401', async () => {
    const { user, fixture } = await grantedFixture('file-a.mp4');
    const other = await createMovieFixture('file-b.mp4');
    await grantAccess(user.id, other.libraryId);
    const tokenForA = await tokenViaApi(user, fixture.mediaFileId);

    const response = await requestDirect('GET', other.mediaFileId, tokenForA);

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token whose user has since been deleted with 401', async () => {
    const { user, fixture, token } = await grantedFixture('deleted-user.mp4');
    await prisma.user.delete({ where: { id: user.id } });

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token whose user has since been disabled with 403 ACCOUNT_DISABLED', async () => {
    const { user, fixture, token } = await grantedFixture('disabled-user.mp4');

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${user.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { isEnabled: false },
    });
    expect(disable.statusCode).toBe(200);

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('direct play: library access enforcement', () => {
  it('cloaks an ungranted file behind a 404 byte-identical to a nonexistent id', async () => {
    const user = await registerUser(); // no grants at all
    const fixture = await createMovieFixture('ungranted.mp4');

    // Both tokens minted out-of-band: issuance would refuse them, and the
    // stream route must independently refuse to honour them.
    const ungranted = await requestDirect(
      'GET',
      fixture.mediaFileId,
      mintToken(user.id, fixture.mediaFileId),
    );
    const nonexistent = await requestDirect(
      'GET',
      'no-such-media-file',
      mintToken(user.id, 'no-such-media-file'),
    );

    expect(ungranted.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    // Byte-identical bodies: nothing distinguishes "exists but not yours"
    // from "does not exist", so media file ids cannot be enumerated.
    expect(ungranted.body).toBe(nonexistent.body);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('stops streaming the moment a grant is revoked, even with a live token', async () => {
    const { user, fixture, token } = await grantedFixture('revoked.mp4');
    expect((await requestDirect('GET', fixture.mediaFileId, token)).statusCode).toBe(200);

    await prisma.libraryAccess.deleteMany({
      where: { userId: user.id, libraryId: fixture.libraryId },
    });

    // The token itself is still validly signed and unexpired — access must
    // be re-checked at use time (statelessness contract).
    const response = await requestDirect('GET', fixture.mediaFileId, token);
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('lets an admin stream any file without an explicit grant', async () => {
    const fixture = await createMovieFixture('admin-any.mp4');
    const token = await tokenViaApi(admin, fixture.mediaFileId);

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(fixture.content)).toBe(true);
  });
});

describe('direct play: path safety', () => {
  it('responds 404 and marks the row missing when the file vanished after scan', async () => {
    const { fixture, token } = await grantedFixture('vanishing.mp4');
    await unlink(fixture.filePath);

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    const row = await prisma.mediaFile.findUniqueOrThrow({ where: { id: fixture.mediaFileId } });
    expect(row.status).toBe('missing');
  });

  it('refuses to follow a symlink that now escapes the media roots', async () => {
    const { fixture, token } = await grantedFixture('escaping.mp4');
    const secret = path.join(outsideDir, 'secret.mp4');
    await writeFile(secret, fixtureBytes(64));
    // Simulate a post-scan swap: the stored path now points outside roots.
    await unlink(fixture.filePath);
    await symlink(secret, fixture.filePath);

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    // The path still resolves — it is unsafe, not missing.
    const row = await prisma.mediaFile.findUniqueOrThrow({ where: { id: fixture.mediaFileId } });
    expect(row.status).toBe('available');
  });

  it('still serves a symlink that resolves inside the media roots', async () => {
    const { fixture, token } = await grantedFixture('internal-link.mp4');
    const target = path.join(moviesDir, 'internal-link-target.mp4');
    await writeFile(target, fixture.content);
    await unlink(fixture.filePath);
    await symlink(target, fixture.filePath);

    const response = await requestDirect('GET', fixture.mediaFileId, token);

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(fixture.content)).toBe(true);
  });
});

describe('direct play: real client behaviour', () => {
  it('streams a real ffmpeg-generated mp4 byte-for-byte, full and ranged', async () => {
    // End-to-end sanity check with genuine video bytes. ffmpeg is a hard
    // requirement of this project (Docker image + CI both ship it).
    const mp4Path = path.join(moviesDir, 'real-video.mp4');
    // prettier-ignore
    await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      mp4Path,
    ]);
    const realBytes = await readFile(mp4Path);
    expect(realBytes.length).toBeGreaterThan(1000);

    const user = await registerUser();
    const fixture = await createMovieFixture('real-video-row.mp4');
    // Point the row at the real mp4 instead of the placeholder fixture.
    await prisma.mediaFile.update({
      where: { id: fixture.mediaFileId },
      data: { path: mp4Path, size: BigInt(realBytes.length) },
    });
    await grantAccess(user.id, fixture.libraryId);
    const token = await tokenViaApi(user, fixture.mediaFileId);

    const full = await requestDirect('GET', fixture.mediaFileId, token);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(realBytes)).toBe(true);

    const slice = await requestDirect('GET', fixture.mediaFileId, token, {
      range: `bytes=500-${realBytes.length - 1}`,
    });
    expect(slice.statusCode).toBe(206);
    expect(slice.rawPayload.equals(realBytes.subarray(500))).toBe(true);
  }, 60_000);

  it('survives a client aborting mid-stream', async () => {
    // 4 MiB is comfortably larger than socket buffers, so the abort lands
    // while the read stream is still flowing.
    const { fixture, token } = await grantedFixture('abort.mp4', fixtureBytes(4 * 1024 * 1024));

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no listen address');

    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port: address.port,
          path: `/api/stream/direct/${fixture.mediaFileId}?token=${token}`,
        },
        (response) => {
          expect(response.statusCode).toBe(200);
          response.once('data', () => {
            // First chunk arrived: rip the connection down mid-body.
            request.destroy();
            resolve();
          });
        },
      );
      request.on('error', reject);
    });

    // Give the server a beat to observe the abort, then prove it still works.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await requestDirect('GET', fixture.mediaFileId, token, {
      range: 'bytes=0-99',
    });
    expect(after.statusCode).toBe(206);
    expect(after.rawPayload.equals(fixture.content.subarray(0, 100))).toBe(true);
  });
});
