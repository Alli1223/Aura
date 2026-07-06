import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { secretsFilePath } from '../lib/secrets.js';
import { issueStreamToken } from '../streaming/stream-tokens.js';

// Integration tests for parental controls (per-user content-rating caps),
// enforced SERVER-SIDE alongside library grants on every media surface. A
// realistic fixture graph — a movies library (G/PG/PG-13/R/unrated) and a tv
// library (a TV-MA show and a PG-13 show, each with an episode carrying NO own
// rating) — is built through prisma; requests go through the real app. One user
// is capped at PG-13, one is uncapped, and the first-registered user is the
// admin (exempt). Access is proven via the same byte-identical 404 cloak the
// library-grant checks use: a rating block is indistinguishable from a
// missing/ungranted item.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';
const TOKEN_TTL_MS = 3_600_000;

let tempDir: string;
let configDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let streamTokenSecret: string;

interface Session {
  id: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface SerializedItem {
  id: string;
  contentRating: string | null;
}
interface ListBody {
  items: SerializedItem[];
  total: number;
}

let admin: Session; // first registered user (exempt)
let restricted: Session; // cap: PG-13
let uncapped: Session; // no cap

let moviesLibId: string;
let tvLibId: string;
let gMovie: string;
let pgMovie: string;
let pg13Movie: string;
let rMovie: string;
let unratedMovie: string;
let rMovieFileId: string;
let pgMovieFileId: string;
let maShow: string;
let maEpisode: string;
let maEpisodeFileId: string;
let pg13Show: string;
let pg13Episode: string;

/** Missing-id cloak body every surface must match, byte for byte. */
let cloakBody: string;

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

function get(url: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

function post(
  url: string,
  token: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function patch(
  url: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PATCH',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function grant(userId: string, libraryId: string) {
  return prisma.libraryAccess.create({ data: { userId, libraryId } });
}

async function createMovie(
  libraryId: string,
  title: string,
  contentRating: string | null,
): Promise<string> {
  const item = await prisma.mediaItem.create({
    data: { libraryId, type: 'movie', title, sortTitle: title.toLowerCase(), contentRating },
  });
  return item.id;
}

/** A MediaFile row (not on disk) with a video/audio/subtitle stream. */
async function addFile(mediaItemId: string): Promise<string> {
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId,
      path: `/media/x/${randomUUID()}.mkv`,
      size: 64n,
      mtimeMs: 0n,
      container: 'mkv',
      videoCodec: 'h264',
      width: 1920,
      height: 1080,
      streams: {
        create: [
          { streamIndex: 0, type: 'video', codec: 'h264' },
          { streamIndex: 1, type: 'audio', codec: 'aac', channels: 6, isDefault: true },
          { streamIndex: 2, type: 'subtitle', codec: 'subrip', language: 'eng' },
        ],
      },
    },
  });
  return file.id;
}

/** A show -> season -> episode; the episode carries no own rating (inherits). */
async function createShowWithEpisode(
  libraryId: string,
  title: string,
  showRating: string | null,
): Promise<{ showId: string; episodeId: string }> {
  const show = await prisma.mediaItem.create({
    data: { libraryId, type: 'show', title, sortTitle: title.toLowerCase(), contentRating: showRating },
  });
  const season = await prisma.mediaItem.create({
    data: {
      libraryId,
      type: 'season',
      title: 'Season 1',
      sortTitle: 'season 1',
      seasonNumber: 1,
      parentId: show.id,
    },
  });
  const episode = await prisma.mediaItem.create({
    data: {
      libraryId,
      type: 'episode',
      title: `${title} S1E1`,
      sortTitle: `${title.toLowerCase()} s1e1`,
      seasonNumber: 1,
      episodeNumber: 1,
      parentId: season.id,
      contentRating: null,
    },
  });
  return { showId: show.id, episodeId: episode.id };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-parental-test-'));
  configDir = path.join(tempDir, 'config');
  const mediaRoot = path.join(tempDir, 'media');
  await mkdir(mediaRoot, { recursive: true });

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

  admin = await registerUser(); // first user -> admin
  restricted = await registerUser();
  uncapped = await registerUser();

  const secrets = JSON.parse(await readFile(secretsFilePath(configDir), 'utf8')) as {
    streamTokenSecret: string;
  };
  streamTokenSecret = secrets.streamTokenSecret;

  const moviesLib = await prisma.library.create({
    data: { name: `Movies ${randomUUID().slice(0, 8)}`, type: 'movies' },
  });
  const tvLib = await prisma.library.create({
    data: { name: `TV ${randomUUID().slice(0, 8)}`, type: 'tv' },
  });
  moviesLibId = moviesLib.id;
  tvLibId = tvLib.id;

  for (const user of [restricted, uncapped]) {
    await grant(user.id, moviesLibId);
    await grant(user.id, tvLibId);
  }

  gMovie = await createMovie(moviesLibId, 'Green', 'G');
  pgMovie = await createMovie(moviesLibId, 'Puppy', 'PG');
  pg13Movie = await createMovie(moviesLibId, 'Teen', 'PG-13');
  rMovie = await createMovie(moviesLibId, 'Restricted', 'R');
  unratedMovie = await createMovie(moviesLibId, 'Mystery', null);
  rMovieFileId = await addFile(rMovie);
  pgMovieFileId = await addFile(pgMovie);

  const ma = await createShowWithEpisode(tvLibId, 'Mature', 'TV-MA');
  maShow = ma.showId;
  maEpisode = ma.episodeId;
  maEpisodeFileId = await addFile(maEpisode);
  const pg13 = await createShowWithEpisode(tvLibId, 'Family', 'PG-13');
  pg13Show = pg13.showId;
  pg13Episode = pg13.episodeId;

  // Apply the PG-13 cap to the restricted user (uncapped stays null).
  const set = await patch(`/api/users/${restricted.id}`, admin.accessToken, {
    maxContentRating: 'PG-13',
  });
  expect(set.statusCode).toBe(200);

  cloakBody = (await get('/api/items/no-such-item-id', restricted.accessToken)).body;
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('detail surface — item-level enforcement', () => {
  it('cloaks an over-cap movie behind the byte-identical missing 404', async () => {
    const blocked = await get(`/api/items/${rMovie}`, restricted.accessToken);
    expect(blocked.statusCode).toBe(404);
    expect(blocked.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(blocked.body).toBe(cloakBody);
  });

  it('allows items at or below the cap, and unrated items by default', async () => {
    for (const id of [gMovie, pgMovie, pg13Movie, unratedMovie]) {
      const response = await get(`/api/items/${id}`, restricted.accessToken);
      expect(response.statusCode, id).toBe(200);
    }
  });

  it('inherits the show rating for a season/episode with no own rating', async () => {
    // The TV-MA show and its (unrated) episode are both blocked.
    expect((await get(`/api/items/${maShow}`, restricted.accessToken)).statusCode).toBe(404);
    expect((await get(`/api/items/${maEpisode}`, restricted.accessToken)).statusCode).toBe(404);
    // The PG-13 show and its episode are both visible.
    expect((await get(`/api/items/${pg13Show}`, restricted.accessToken)).statusCode).toBe(200);
    expect((await get(`/api/items/${pg13Episode}`, restricted.accessToken)).statusCode).toBe(200);
  });

  it('blocks the children route for an over-cap container', async () => {
    expect((await get(`/api/items/${maShow}/children`, restricted.accessToken)).statusCode).toBe(
      404,
    );
    expect((await get(`/api/items/${pg13Show}/children`, restricted.accessToken)).statusCode).toBe(
      200,
    );
  });

  it('exempts admins and uncapped users (they see the R movie and TV-MA show)', async () => {
    for (const token of [admin.accessToken, uncapped.accessToken]) {
      expect((await get(`/api/items/${rMovie}`, token)).statusCode).toBe(200);
      expect((await get(`/api/items/${maShow}`, token)).statusCode).toBe(200);
      expect((await get(`/api/items/${maEpisode}`, token)).statusCode).toBe(200);
    }
  });
});

describe('browse / search / feeds — listing filters (counts consistent)', () => {
  it('excludes over-cap items from a library listing and its count', async () => {
    const response = await get(
      `/api/libraries/${moviesLibId}/items?pageSize=100`,
      restricted.accessToken,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<ListBody>();
    const ids = body.items.map((i) => i.id);
    expect(ids).not.toContain(rMovie);
    expect(ids).toEqual(expect.arrayContaining([gMovie, pgMovie, pg13Movie, unratedMovie]));
    // The count matches the filtered set (all four allowed movies, no R).
    expect(body.total).toBe(4);
    expect(body.total).toBe(body.items.length);
  });

  it('shows the full library (incl. the R movie) to an uncapped user', async () => {
    const response = await get(
      `/api/libraries/${moviesLibId}/items?pageSize=100`,
      uncapped.accessToken,
    );
    const body = response.json<ListBody>();
    expect(body.items.map((i) => i.id)).toContain(rMovie);
    expect(body.total).toBe(5);
  });

  it('excludes over-cap items (and shows) from search', async () => {
    const blocked = await get('/api/search?q=Restricted', restricted.accessToken);
    expect(blocked.json<{ results: SerializedItem[] }>().results).toHaveLength(0);
    const show = await get('/api/search?q=Mature', restricted.accessToken);
    expect(show.json<{ results: SerializedItem[] }>().results).toHaveLength(0);

    // The uncapped user finds both.
    expect(
      (await get('/api/search?q=Restricted', uncapped.accessToken)).json<{
        results: SerializedItem[];
      }>().results,
    ).toHaveLength(1);

    // A permitted title is still found by the restricted user.
    const allowed = await get('/api/search?q=Family', restricted.accessToken);
    expect(allowed.json<{ results: SerializedItem[] }>().results).toHaveLength(1);
  });

  it('excludes over-cap items from recently-added (library + home)', async () => {
    const lib = await get(
      `/api/libraries/${moviesLibId}/recently-added?limit=100`,
      restricted.accessToken,
    );
    expect(lib.json<{ items: SerializedItem[] }>().items.map((i) => i.id)).not.toContain(rMovie);

    const home = await get('/api/home/recently-added?limit=100', restricted.accessToken);
    const homeIds = home.json<{ items: SerializedItem[] }>().items.map((i) => i.id);
    expect(homeIds).not.toContain(rMovie);
    expect(homeIds).not.toContain(maShow);
    expect(homeIds).toEqual(expect.arrayContaining([pg13Show, pgMovie]));

    // Uncapped: the R movie and the TV-MA show are present.
    const homeAll = await get('/api/home/recently-added?limit=100', uncapped.accessToken);
    const allIds = homeAll.json<{ items: SerializedItem[] }>().items.map((i) => i.id);
    expect(allIds).toEqual(expect.arrayContaining([rMovie, maShow]));
  });

  it('excludes over-cap entries from continue-watching (episode inherits show)', async () => {
    // Seed in-progress state: a permitted movie and a blocked-show episode.
    for (const [userId, ids] of [
      [restricted.id, [pgMovie, maEpisode]],
      [uncapped.id, [maEpisode]],
    ] as const) {
      for (const mediaItemId of ids) {
        await prisma.watchState.upsert({
          where: { userId_mediaItemId: { userId, mediaItemId } },
          create: { userId, mediaItemId, positionMs: 60_000, watched: false },
          update: { positionMs: 60_000, watched: false },
        });
      }
    }

    const restrictedCw = await get('/api/continue-watching', restricted.accessToken);
    const restrictedIds = restrictedCw
      .json<{ items: { mediaItemId: string }[] }>()
      .items.map((i) => i.mediaItemId);
    expect(restrictedIds).toContain(pgMovie);
    expect(restrictedIds).not.toContain(maEpisode);

    // Uncapped keeps the blocked-show episode.
    const uncappedCw = await get('/api/continue-watching', uncapped.accessToken);
    expect(
      uncappedCw.json<{ items: { mediaItemId: string }[] }>().items.map((i) => i.mediaItemId),
    ).toContain(maEpisode);
  });

  it('omits over-cap ids from the batch watch-state map (no progress leak)', async () => {
    const requestBody = { ids: [pgMovie, rMovie, maEpisode] };
    const restrictedStates = await post(
      '/api/items/state',
      restricted.accessToken,
      requestBody,
    );
    const restrictedMap = restrictedStates.json<{ states: Record<string, unknown> }>().states;
    // The permitted movie's seeded state is present; the R movie and the
    // blocked-show episode are absent, just as an inaccessible id would be.
    expect(restrictedMap[pgMovie]).toBeDefined();
    expect(restrictedMap[rMovie]).toBeUndefined();
    expect(restrictedMap[maEpisode]).toBeUndefined();

    // The uncapped user sees the blocked-show episode's state.
    const uncappedStates = await post('/api/items/state', uncapped.accessToken, {
      ids: [maEpisode],
    });
    expect(
      uncappedStates.json<{ states: Record<string, unknown> }>().states[maEpisode],
    ).toBeDefined();
  });
});

describe('blockUnratedForRestrictedUsers setting', () => {
  it('hides unrated items from restricted users when enabled, never from uncapped', async () => {
    const on = await patch('/api/settings', admin.accessToken, {
      blockUnratedForRestrictedUsers: true,
    });
    expect(on.statusCode).toBe(200);

    try {
      // Detail: the unrated movie now cloaks for the restricted user.
      expect((await get(`/api/items/${unratedMovie}`, restricted.accessToken)).statusCode).toBe(
        404,
      );
      // Listing excludes it and the count drops to the three rated-allowed movies.
      const list = await get(
        `/api/libraries/${moviesLibId}/items?pageSize=100`,
        restricted.accessToken,
      );
      const body = list.json<ListBody>();
      expect(body.items.map((i) => i.id)).not.toContain(unratedMovie);
      expect(body.total).toBe(3);
      // Uncapped users are unaffected.
      expect((await get(`/api/items/${unratedMovie}`, uncapped.accessToken)).statusCode).toBe(200);
    } finally {
      const off = await patch('/api/settings', admin.accessToken, {
        blockUnratedForRestrictedUsers: false,
      });
      expect(off.statusCode).toBe(200);
    }

    // Restored: the unrated movie is visible again by default.
    expect((await get(`/api/items/${unratedMovie}`, restricted.accessToken)).statusCode).toBe(200);
  });
});

describe('stream surfaces — token, decide and use-time re-check', () => {
  it('cloaks token issuance for an over-cap file (byte-identical to a missing file)', async () => {
    const blocked = await post('/api/stream/token', restricted.accessToken, {
      mediaFileId: rMovieFileId,
    });
    const missing = await post('/api/stream/token', restricted.accessToken, {
      mediaFileId: 'no-such-file',
    });
    expect(blocked.statusCode).toBe(404);
    expect(blocked.body).toBe(missing.body);
    expect(blocked.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    // A permitted file issues a token normally.
    expect(
      (await post('/api/stream/token', restricted.accessToken, { mediaFileId: pgMovieFileId }))
        .statusCode,
    ).toBe(200);
  });

  it('cloaks the playback decision for an over-cap file, allows a permitted one', async () => {
    expect(
      (await post(`/api/stream/decide/${rMovieFileId}`, restricted.accessToken, {})).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/stream/decide/${pgMovieFileId}`, restricted.accessToken, {})).statusCode,
    ).toBe(200);
  });

  it('re-checks the cap at use time on direct / hls / audio / subtitles (cloaked 404)', async () => {
    // A token minted while the file was reachable stays valid, but every stream
    // route re-checks access per request against the freshly-loaded (capped)
    // user — proving a cap change (or an episode inheriting a blocked show)
    // stops playback the same way a grant revocation does.
    const rToken = issueStreamToken({
      userId: restricted.id,
      mediaFileId: rMovieFileId,
      secret: streamTokenSecret,
      ttlMs: TOKEN_TTL_MS,
    }).token;
    const q = `token=${encodeURIComponent(rToken)}`;

    const surfaces = [
      { method: 'GET' as const, url: `/api/stream/direct/${rMovieFileId}?${q}` },
      { method: 'POST' as const, url: `/api/stream/hls/${rMovieFileId}?${q}` },
      { method: 'GET' as const, url: `/api/stream/audio/${rMovieFileId}?${q}` },
      { method: 'GET' as const, url: `/api/stream/subtitles/${rMovieFileId}?${q}` },
    ];
    for (const surface of surfaces) {
      const response = await app.inject({ method: surface.method, url: surface.url });
      expect(response.statusCode, surface.url).toBe(404);
      expect(response.body, surface.url).toBe(cloakBody);
    }

    // The same for an episode inheriting a blocked show's rating.
    const epToken = issueStreamToken({
      userId: restricted.id,
      mediaFileId: maEpisodeFileId,
      secret: streamTokenSecret,
      ttlMs: TOKEN_TTL_MS,
    }).token;
    const epResponse = await get(
      `/api/stream/audio/${maEpisodeFileId}?token=${encodeURIComponent(epToken)}`,
    );
    expect(epResponse.statusCode).toBe(404);
    expect(epResponse.body).toBe(cloakBody);
  });
});
