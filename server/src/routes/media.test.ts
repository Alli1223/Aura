import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for the browse (read) API against a real temporary SQLite
// database. A realistic fixture graph — a movie library with several movies,
// genres, files, streams and watch states, plus a tv library with shows ->
// seasons -> episodes — is built directly through prisma; requests go through
// the real app so authentication, validation, serialization and the access
// cloak are exercised end to end. One user is granted both libraries; a second
// user has no grants (to prove the 404 cloak).

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface Session {
  id: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface SerializedItem {
  id: string;
  libraryId: string;
  type: string;
  title: string;
  sortTitle: string;
  year: number | null;
  genres: string[];
  posterUrl: string | null;
  backdropUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  watchState: {
    watched: boolean;
    positionMs: number;
    episodeCount: number;
    watchedEpisodeCount: number;
    nextUnwatchedId: string | null;
  };
}
interface SerializedEpisode extends SerializedItem {
  hasFile: boolean;
  primaryMediaFileId: string | null;
}

/** Every id the fixture graph produces, keyed for readable assertions. */
interface Fixture {
  movieLibId: string;
  tvLibId: string;
  movieA: string; // Alpha  2001 r5.0 Action  watched, has file
  movieB: string; // Bravo  1999 r9.0 Comedy  unwatched, no file
  movieC: string; // Charlie 2010 r7.0 Action in-progress, has file
  movieAFileId: string;
  showZeta: string; // 2 seasons, partially watched -> derived unwatched
  zetaS1: string; // fully watched
  zetaS2: string; // unwatched
  zetaS2E1: string; // has file, unwatched (show's next-unwatched)
  zetaS2E1FileId: string;
  zetaS2E2: string; // NO file, unwatched
  showYankee: string; // fully watched -> derived watched
}

let fx: Fixture;
let userA: Session; // granted both libraries
let userB: Session; // no grants

function auth(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

function get(url: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: auth(token) });
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

/** A file (with an audio + a subtitle stream) backing an item; returns its id. */
async function addFile(mediaItemId: string, name: string): Promise<string> {
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId,
      path: `/media/movies/${name}-${randomUUID().slice(0, 8)}.mkv`,
      size: 2_147_483_648n, // > 2^31 to prove BigInt -> number survives
      mtimeMs: 0n,
      container: 'mkv',
      durationMs: 5_400_000,
      bitrate: 8_000_000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      streams: {
        create: [
          {
            streamIndex: 1,
            type: 'audio',
            codec: 'aac',
            language: 'eng',
            title: 'English',
            channels: 6,
            isDefault: true,
          },
          {
            streamIndex: 2,
            type: 'subtitle',
            codec: 'subrip',
            language: 'eng',
            title: null,
            isForced: false,
          },
        ],
      },
      chapters: {
        create: [
          { index: 0, startMs: 0, endMs: 60_000, title: 'Opening' },
          { index: 1, startMs: 60_000, endMs: 5_400_000, title: null },
        ],
      },
    },
  });
  return file.id;
}

function markWatched(mediaItemId: string): Promise<unknown> {
  return prisma.watchState.create({
    data: { userId: userA.id, mediaItemId, watched: true, watchedAt: new Date(), playCount: 1 },
  });
}

/** Builds the whole fixture graph and grants userA both libraries. */
async function seed(): Promise<Fixture> {
  const movieLib = await prisma.library.create({ data: { name: 'Movies', type: 'movies' } });
  const tvLib = await prisma.library.create({ data: { name: 'Shows', type: 'tv' } });

  const t = (n: number): Date => new Date(Date.UTC(2026, 0, n));

  const movieA = await prisma.mediaItem.create({
    data: {
      libraryId: movieLib.id,
      type: 'movie',
      title: 'Alpha',
      sortTitle: 'alpha',
      year: 2001,
      overview: 'The first movie.',
      tagline: 'It begins.',
      runtimeMs: 5_400_000,
      contentRating: 'PG-13',
      communityRating: 5,
      posterPath: 'tmdb:/alpha-poster.jpg',
      backdropPath: 'anilist:https://s4.anilist.co/alpha-back.jpg',
      addedAt: t(1),
      genres: { connectOrCreate: [{ where: { name: 'Action' }, create: { name: 'Action' } }] },
    },
  });
  const movieAFileId = await addFile(movieA.id, 'alpha');
  await markWatched(movieA.id);

  const movieB = await prisma.mediaItem.create({
    data: {
      libraryId: movieLib.id,
      type: 'movie',
      title: 'Bravo',
      sortTitle: 'bravo',
      year: 1999,
      communityRating: 9,
      posterPath: null,
      addedAt: t(2),
      genres: { connectOrCreate: [{ where: { name: 'Comedy' }, create: { name: 'Comedy' } }] },
    },
  });

  const movieC = await prisma.mediaItem.create({
    data: {
      libraryId: movieLib.id,
      type: 'movie',
      title: 'Charlie',
      sortTitle: 'charlie',
      year: 2010,
      communityRating: 7,
      posterPath: 'tmdb:/charlie-poster.jpg',
      addedAt: t(3),
      genres: { connectOrCreate: [{ where: { name: 'Action' }, create: { name: 'Action' } }] },
    },
  });
  await addFile(movieC.id, 'charlie');
  await prisma.watchState.create({
    data: { userId: userA.id, mediaItemId: movieC.id, positionMs: 5_000, watched: false },
  });

  // Show Zeta: 2 seasons, season 1 fully watched, season 2 unwatched.
  const showZeta = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'show',
      title: 'Zeta',
      sortTitle: 'zeta',
      posterPath: 'tmdb:/zeta-poster.jpg',
      addedAt: t(4),
    },
  });
  const zetaS1 = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'season',
      parentId: showZeta.id,
      title: 'Season 1',
      sortTitle: 'season 1',
      seasonNumber: 1,
    },
  });
  for (const n of [1, 2]) {
    const ep = await prisma.mediaItem.create({
      data: {
        libraryId: tvLib.id,
        type: 'episode',
        parentId: zetaS1.id,
        title: `Zeta S1E${n}`,
        sortTitle: `zeta s1e${n}`,
        seasonNumber: 1,
        episodeNumber: n,
      },
    });
    await addFile(ep.id, `zeta-s1e${n}`);
    await markWatched(ep.id);
  }
  const zetaS2 = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'season',
      parentId: showZeta.id,
      title: 'Season 2',
      sortTitle: 'season 2',
      seasonNumber: 2,
    },
  });
  const zetaS2E1 = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'episode',
      parentId: zetaS2.id,
      title: 'Zeta S2E1',
      sortTitle: 'zeta s2e1',
      seasonNumber: 2,
      episodeNumber: 1,
    },
  });
  const zetaS2E1FileId = await addFile(zetaS2E1.id, 'zeta-s2e1');
  const zetaS2E2 = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'episode',
      parentId: zetaS2.id,
      title: 'Zeta S2E2',
      sortTitle: 'zeta s2e2',
      seasonNumber: 2,
      episodeNumber: 2,
    },
  });

  // Show Yankee: one season, fully watched -> derived watched.
  const showYankee = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'show',
      title: 'Yankee',
      sortTitle: 'yankee',
      addedAt: t(5),
    },
  });
  const yankeeS1 = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'season',
      parentId: showYankee.id,
      title: 'Season 1',
      sortTitle: 'season 1',
      seasonNumber: 1,
    },
  });
  for (const n of [1, 2]) {
    const ep = await prisma.mediaItem.create({
      data: {
        libraryId: tvLib.id,
        type: 'episode',
        parentId: yankeeS1.id,
        title: `Yankee S1E${n}`,
        sortTitle: `yankee s1e${n}`,
        seasonNumber: 1,
        episodeNumber: n,
      },
    });
    await addFile(ep.id, `yankee-s1e${n}`);
    await markWatched(ep.id);
  }

  await prisma.libraryAccess.createMany({
    data: [
      { userId: userA.id, libraryId: movieLib.id },
      { userId: userA.id, libraryId: tvLib.id },
    ],
  });

  return {
    movieLibId: movieLib.id,
    tvLibId: tvLib.id,
    movieA: movieA.id,
    movieB: movieB.id,
    movieC: movieC.id,
    movieAFileId,
    showZeta: showZeta.id,
    zetaS1: zetaS1.id,
    zetaS2: zetaS2.id,
    zetaS2E1: zetaS2E1.id,
    zetaS2E1FileId,
    zetaS2E2: zetaS2E2.id,
    showYankee: showYankee.id,
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-media-test-'));
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

  // Consume the first-run admin slot so userA/userB are ordinary users that the
  // access checks actually gate (an admin would bypass every grant).
  await registerUser();
  userA = await registerUser();
  userB = await registerUser();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.watchState.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.libraryAccess.deleteMany();
  await prisma.library.deleteMany();
  await prisma.genre.deleteMany();
  fx = await seed();
});

describe('authentication', () => {
  it('rejects every browse route without a token (401 UNAUTHORIZED)', async () => {
    const responses = await Promise.all([
      get(`/api/libraries/${fx.movieLibId}/items`),
      get(`/api/libraries/${fx.movieLibId}/recently-added`),
      get('/api/home/recently-added'),
      get(`/api/items/${fx.movieA}`),
      get(`/api/items/${fx.showZeta}/children`),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('GET /api/libraries/:id/items', () => {
  function listItems(res: LightMyRequestResponse): SerializedItem[] {
    return res.json<{ items: SerializedItem[] }>().items;
  }

  it('returns only top-level items with the safe serialized shape', async () => {
    const res = await get(`/api/libraries/${fx.movieLibId}/items`, userA.accessToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: SerializedItem[];
      page: number;
      pageSize: number;
      total: number;
    }>();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(48);
    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(body.items.every((i) => i.type === 'movie')).toBe(true);

    const alpha = body.items.find((i) => i.id === fx.movieA)!;
    expect(alpha.genres).toEqual(['Action']);
    expect(alpha.year).toBe(2001);
    // posterUrl is the artwork ROUTE, never the raw tmdb:/anilist: uri.
    expect(alpha.posterUrl).toBe(`/api/items/${fx.movieA}/artwork/poster`);
    expect(alpha.backdropUrl).toBe(`/api/items/${fx.movieA}/artwork/backdrop`);
    expect(alpha.watchState.watched).toBe(true);
    // A movie without artwork exposes null (not an empty/placeholder uri).
    const bravo = body.items.find((i) => i.id === fx.movieB)!;
    expect(bravo.posterUrl).toBeNull();
  });

  it('returns only top-level shows (never seasons/episodes) for a tv library', async () => {
    const items = listItems(await get(`/api/libraries/${fx.tvLibId}/items`, userA.accessToken));
    expect(items.map((i) => i.title)).toEqual(['Yankee', 'Zeta']);
    expect(items.every((i) => i.type === 'show')).toBe(true);
  });

  it('sorts by title/year/added/rating in both directions', async () => {
    const url = (q: string): string => `/api/libraries/${fx.movieLibId}/items?${q}`;
    const titles = async (q: string): Promise<string[]> =>
      listItems(await get(url(q), userA.accessToken)).map((i) => i.title);

    expect(await titles('sort=title&order=asc')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(await titles('sort=title&order=desc')).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(await titles('sort=year&order=asc')).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(await titles('sort=year&order=desc')).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(await titles('sort=rating&order=asc')).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(await titles('sort=rating&order=desc')).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(await titles('sort=added&order=asc')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(await titles('sort=added&order=desc')).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('filters by genre and by year', async () => {
    const url = (q: string): string => `/api/libraries/${fx.movieLibId}/items?${q}`;
    const action = listItems(await get(url('genre=Action'), userA.accessToken));
    expect(action.map((i) => i.title)).toEqual(['Alpha', 'Charlie']);
    const comedy = listItems(await get(url('genre=Comedy'), userA.accessToken));
    expect(comedy.map((i) => i.title)).toEqual(['Bravo']);
    const y1999 = listItems(await get(url('year=1999'), userA.accessToken));
    expect(y1999.map((i) => i.title)).toEqual(['Bravo']);
    // An empty year= means "no filter" (not year 0), so all movies come back.
    const yEmpty = listItems(await get(url('year='), userA.accessToken));
    expect(yEmpty.map((i) => i.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('filters movies by watched state (leaf)', async () => {
    const url = (q: string): string => `/api/libraries/${fx.movieLibId}/items?${q}`;
    const watched = listItems(await get(url('watched=true'), userA.accessToken));
    expect(watched.map((i) => i.title)).toEqual(['Alpha']); // Charlie is in-progress, not watched
    const unwatched = listItems(await get(url('watched=false'), userA.accessToken));
    expect(unwatched.map((i) => i.title)).toEqual(['Bravo', 'Charlie']);
  });

  it('filters shows by DERIVED watched state (all episodes watched)', async () => {
    const url = (q: string): string => `/api/libraries/${fx.tvLibId}/items?${q}`;
    const watched = listItems(await get(url('watched=true'), userA.accessToken));
    expect(watched.map((i) => i.title)).toEqual(['Yankee']); // Zeta S2 unwatched
    const unwatched = listItems(await get(url('watched=false'), userA.accessToken));
    expect(unwatched.map((i) => i.title)).toEqual(['Zeta']);
  });

  it('paginates with page/pageSize and reports the full total', async () => {
    const url = (q: string): string => `/api/libraries/${fx.movieLibId}/items?${q}`;
    const p1 = (await get(url('pageSize=2&page=1'), userA.accessToken)).json<{
      items: SerializedItem[];
      total: number;
    }>();
    expect(p1.items.map((i) => i.title)).toEqual(['Alpha', 'Bravo']);
    expect(p1.total).toBe(3);
    const p2 = (await get(url('pageSize=2&page=2'), userA.accessToken)).json<{
      items: SerializedItem[];
      total: number;
    }>();
    expect(p2.items.map((i) => i.title)).toEqual(['Charlie']);
    expect(p2.total).toBe(3);
  });

  it('rejects a pageSize over the cap with 400 VALIDATION', async () => {
    const res = await get(`/api/libraries/${fx.movieLibId}/items?pageSize=101`, userA.accessToken);
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('searches by title substring within the library', async () => {
    const url = (q: string): string => `/api/libraries/${fx.movieLibId}/items?${q}`;
    expect(listItems(await get(url('search=rav'), userA.accessToken)).map((i) => i.title)).toEqual([
      'Bravo',
    ]);
    expect(listItems(await get(url('search=har'), userA.accessToken)).map((i) => i.title)).toEqual([
      'Charlie',
    ]);
  });

  it('cloaks an ungranted and a missing library with a byte-identical 404', async () => {
    const ungranted = await get(`/api/libraries/${fx.movieLibId}/items`, userB.accessToken);
    const missing = await get('/api/libraries/no-such-library/items', userB.accessToken);
    expect(ungranted.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(ungranted.body).toBe(missing.body);
  });
});

describe('GET /api/items/:id (detail)', () => {
  it('returns a movie with its files, audio/subtitle streams and watch state', async () => {
    const res = await get(`/api/items/${fx.movieA}`, userA.accessToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      item: SerializedItem;
      files: Array<{
        id: string;
        container: string;
        size: number;
        audioStreams: Array<{ index: number; codec: string; channels: number; default: boolean }>;
        subtitleStreams: Array<{ index: number; codec: string; forced: boolean }>;
        chapters: Array<{ index: number; startMs: number; endMs: number; title: string | null }>;
      }>;
      seasons: unknown[];
      episodes: unknown[];
    }>();

    expect(body.item.id).toBe(fx.movieA);
    expect(body.item.watchState.watched).toBe(true);
    expect(body.seasons).toEqual([]);
    expect(body.episodes).toEqual([]);

    expect(body.files).toHaveLength(1);
    const file = body.files[0]!;
    expect(file.id).toBe(fx.movieAFileId);
    expect(file.container).toBe('mkv');
    expect(typeof file.size).toBe('number');
    expect(file.size).toBe(2_147_483_648);
    expect(file.audioStreams).toHaveLength(1);
    expect(file.audioStreams[0]).toMatchObject({
      index: 1,
      codec: 'aac',
      channels: 6,
      default: true,
    });
    expect(file.subtitleStreams).toHaveLength(1);
    expect(file.subtitleStreams[0]).toMatchObject({ index: 2, codec: 'subrip', forced: false });
    // Chapter markers are surfaced in file order.
    expect(file.chapters).toEqual([
      { index: 0, startMs: 0, endMs: 60_000, title: 'Opening' },
      { index: 1, startMs: 60_000, endMs: 5_400_000, title: null },
    ]);
    // No filesystem path is exposed on the file.
    expect(JSON.stringify(file)).not.toContain('path');
  });

  it('returns an episode (leaf) with its files and streams', async () => {
    const body = (await get(`/api/items/${fx.zetaS2E1}`, userA.accessToken)).json<{
      item: SerializedItem;
      files: Array<{ id: string; audioStreams: unknown[]; subtitleStreams: unknown[] }>;
      seasons: unknown[];
      episodes: unknown[];
    }>();
    expect(body.item.type).toBe('episode');
    expect(body.seasons).toEqual([]);
    expect(body.episodes).toEqual([]);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]!.id).toBe(fx.zetaS2E1FileId);
    expect(body.files[0]!.audioStreams).toHaveLength(1);
    expect(body.files[0]!.subtitleStreams).toHaveLength(1);
  });

  it('returns a season with its episodes (and no files/seasons)', async () => {
    const body = (await get(`/api/items/${fx.zetaS2}`, userA.accessToken)).json<{
      item: SerializedItem;
      files: unknown[];
      seasons: unknown[];
      episodes: SerializedEpisode[];
    }>();
    expect(body.item.type).toBe('season');
    expect(body.files).toEqual([]);
    expect(body.seasons).toEqual([]);
    expect(body.episodes.map((e) => e.id)).toEqual([fx.zetaS2E1, fx.zetaS2E2]);
    expect(body.episodes.find((e) => e.id === fx.zetaS2E1)!.primaryMediaFileId).toBe(
      fx.zetaS2E1FileId,
    );
  });

  it("excludes a missing (unavailable) file from a movie's playable files", async () => {
    await prisma.mediaFile.update({
      where: { id: fx.movieAFileId },
      data: { status: 'missing' },
    });
    const body = (await get(`/api/items/${fx.movieA}`, userA.accessToken)).json<{
      files: unknown[];
    }>();
    expect(body.files).toEqual([]);
  });

  it('returns a show with its seasons and counts, and no inline episodes', async () => {
    const res = await get(`/api/items/${fx.showZeta}`, userA.accessToken);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ item: SerializedItem; files: unknown[]; seasons: SerializedItem[] }>();

    expect(body.files).toEqual([]);
    // The show's own derived roll-up across both seasons.
    expect(body.item.watchState).toMatchObject({
      watched: false,
      episodeCount: 4,
      watchedEpisodeCount: 2,
      nextUnwatchedId: fx.zetaS2E1,
    });

    expect(body.seasons.map((s) => s.title)).toEqual(['Season 1', 'Season 2']);
    const s1 = body.seasons.find((s) => s.id === fx.zetaS1)!;
    expect(s1.watchState).toMatchObject({ watched: true, episodeCount: 2, watchedEpisodeCount: 2 });
    const s2 = body.seasons.find((s) => s.id === fx.zetaS2)!;
    expect(s2.watchState).toMatchObject({
      watched: false,
      episodeCount: 2,
      watchedEpisodeCount: 0,
    });

    // Detail must not inline the episodes for a show.
    expect(JSON.stringify(body)).not.toContain('Zeta S2E1');
  });

  it('cloaks an ungranted and a missing item with a byte-identical 404', async () => {
    const ungranted = await get(`/api/items/${fx.movieA}`, userB.accessToken);
    const missing = await get('/api/items/no-such-item', userB.accessToken);
    expect(ungranted.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(ungranted.body).toBe(missing.body);
  });
});

describe('GET /api/items/:id/children', () => {
  it("returns a show's seasons", async () => {
    const items = (await get(`/api/items/${fx.showZeta}/children`, userA.accessToken)).json<{
      items: SerializedItem[];
    }>().items;
    expect(items.map((i) => i.title)).toEqual(['Season 1', 'Season 2']);
    expect(items.every((i) => i.type === 'season')).toBe(true);
  });

  it("returns a season's episodes with watch state, hasFile and primaryMediaFileId", async () => {
    const items = (await get(`/api/items/${fx.zetaS2}/children`, userA.accessToken)).json<{
      items: SerializedEpisode[];
    }>().items;
    expect(items.map((i) => i.title)).toEqual(['Zeta S2E1', 'Zeta S2E2']);

    const e1 = items.find((i) => i.id === fx.zetaS2E1)!;
    expect(e1.hasFile).toBe(true);
    expect(e1.primaryMediaFileId).toBe(fx.zetaS2E1FileId);
    expect(e1.watchState.watched).toBe(false);

    const e2 = items.find((i) => i.id === fx.zetaS2E2)!;
    expect(e2.hasFile).toBe(false);
    expect(e2.primaryMediaFileId).toBeNull();
  });

  it('returns an empty list for a leaf (movie)', async () => {
    const items = (await get(`/api/items/${fx.movieA}/children`, userA.accessToken)).json<{
      items: unknown[];
    }>().items;
    expect(items).toEqual([]);
  });

  it('cloaks an ungranted and a missing item with a byte-identical 404', async () => {
    const ungranted = await get(`/api/items/${fx.showZeta}/children`, userB.accessToken);
    const missing = await get('/api/items/no-such-item/children', userB.accessToken);
    expect(ungranted.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(ungranted.body).toBe(missing.body);
  });

  it('orders next-unwatched season-first, not by episode number alone', async () => {
    // Season 1 has an unwatched high-numbered episode; season 2 a low-numbered
    // one. The next unwatched must be the season-1 episode (season sorts first).
    const show = await prisma.mediaItem.create({
      data: { libraryId: fx.tvLibId, type: 'show', title: 'Cross', sortTitle: 'cross' },
    });
    const s1 = await prisma.mediaItem.create({
      data: {
        libraryId: fx.tvLibId,
        type: 'season',
        parentId: show.id,
        title: 'Season 1',
        sortTitle: 'season 1',
        seasonNumber: 1,
      },
    });
    const s2 = await prisma.mediaItem.create({
      data: {
        libraryId: fx.tvLibId,
        type: 'season',
        parentId: show.id,
        title: 'Season 2',
        sortTitle: 'season 2',
        seasonNumber: 2,
      },
    });
    const s1e9 = await prisma.mediaItem.create({
      data: {
        libraryId: fx.tvLibId,
        type: 'episode',
        parentId: s1.id,
        title: 'Cross S1E9',
        sortTitle: 'cross s1e9',
        seasonNumber: 1,
        episodeNumber: 9,
      },
    });
    await prisma.mediaItem.create({
      data: {
        libraryId: fx.tvLibId,
        type: 'episode',
        parentId: s2.id,
        title: 'Cross S2E1',
        sortTitle: 'cross s2e1',
        seasonNumber: 2,
        episodeNumber: 1,
      },
    });

    const body = (await get(`/api/items/${show.id}`, userA.accessToken)).json<{
      item: SerializedItem;
    }>();
    expect(body.item.watchState.nextUnwatchedId).toBe(s1e9.id);
  });
});

describe('recently-added feeds', () => {
  it("lists a library's most-recently-added top-level items", async () => {
    const items = (
      await get(`/api/libraries/${fx.movieLibId}/recently-added`, userA.accessToken)
    ).json<{ items: SerializedItem[] }>().items;
    expect(items.map((i) => i.title)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('lists recently-added across ALL permitted libraries, newest first', async () => {
    const items = (await get('/api/home/recently-added', userA.accessToken)).json<{
      items: SerializedItem[];
    }>().items;
    expect(items.map((i) => i.title)).toEqual(['Yankee', 'Zeta', 'Charlie', 'Bravo', 'Alpha']);
  });

  it('returns nothing for a user with no library grants', async () => {
    const items = (await get('/api/home/recently-added', userB.accessToken)).json<{
      items: SerializedItem[];
    }>().items;
    expect(items).toEqual([]);
  });

  it('caps the limit query and rejects an over-cap value', async () => {
    const limited = (await get('/api/home/recently-added?limit=2', userA.accessToken)).json<{
      items: SerializedItem[];
    }>().items;
    expect(limited.map((i) => i.title)).toEqual(['Yankee', 'Zeta']);

    const overCap = await get('/api/home/recently-added?limit=101', userA.accessToken);
    expect(overCap.statusCode).toBe(400);
    expect(overCap.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('cloaks recently-added for an ungranted/missing library (byte-identical 404)', async () => {
    const ungranted = await get(
      `/api/libraries/${fx.movieLibId}/recently-added`,
      userB.accessToken,
    );
    const missing = await get('/api/libraries/no-such-library/recently-added', userB.accessToken);
    expect(ungranted.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(ungranted.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    expect(ungranted.body).toBe(missing.body);
  });

  it('breaks an addedAt tie deterministically by id (desc)', async () => {
    // Two items imported at the same instant must still order deterministically.
    const sameInstant = new Date(Date.UTC(2027, 0, 1));
    const a = await prisma.mediaItem.create({
      data: {
        libraryId: fx.movieLibId,
        type: 'movie',
        title: 'Tie One',
        sortTitle: 'tie one',
        addedAt: sameInstant,
      },
    });
    const b = await prisma.mediaItem.create({
      data: {
        libraryId: fx.movieLibId,
        type: 'movie',
        title: 'Tie Two',
        sortTitle: 'tie two',
        addedAt: sameInstant,
      },
    });
    const expectedFirstTwo = [a.id, b.id].sort().reverse();

    const items = (
      await get(`/api/libraries/${fx.movieLibId}/recently-added?limit=2`, userA.accessToken)
    ).json<{ items: SerializedItem[] }>().items;
    expect(items.map((i) => i.id)).toEqual(expectedFirstTwo);
  });
});

describe('non-leaking responses', () => {
  it('never exposes a filesystem path or a raw artwork uri in any response', async () => {
    const responses = await Promise.all([
      get(`/api/libraries/${fx.movieLibId}/items`, userA.accessToken),
      get(`/api/libraries/${fx.tvLibId}/items`, userA.accessToken),
      get(`/api/items/${fx.movieA}`, userA.accessToken),
      get(`/api/items/${fx.showZeta}`, userA.accessToken),
      get(`/api/items/${fx.zetaS2}/children`, userA.accessToken),
      get('/api/home/recently-added', userA.accessToken),
    ]);
    for (const response of responses) {
      const body = response.body;
      expect(body).not.toContain('/media/');
      expect(body).not.toContain('tmdb:');
      expect(body).not.toContain('anilist:');
      expect(body).not.toContain('.mkv');
    }
  });
});
