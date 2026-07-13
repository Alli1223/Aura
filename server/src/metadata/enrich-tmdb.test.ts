import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import { clearSettingsCache, setSettings } from '../lib/settings.js';
import { enrichMovieItem, enrichSeasonAndEpisodes, enrichShowItem } from './enrich-tmdb.js';

// Enrichment round-trips against a real temporary SQLite database (created by
// applying the committed migrations, same approach as persist-probe.test.ts).
// The global fetch is always stubbed with inline TMDB-shaped fixtures — no
// live TMDB calls, ever.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const API_KEY = '0123456789abcdef0123456789abcdef';

let tempDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-enrich-tmdb-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
  clearSettingsCache();
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures (realistic TMDB response shapes, inline)
// ---------------------------------------------------------------------------

function inceptionSearchBody(): unknown {
  return {
    page: 1,
    results: [
      {
        adult: false,
        backdrop_path: '/s3TBrRGB1iav7gFOCNx3H31MoES.jpg',
        genre_ids: [28, 878, 12],
        id: 27205,
        original_language: 'en',
        original_title: 'Inception',
        overview: 'Cobb, a skilled thief...',
        popularity: 83.952,
        poster_path: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
        release_date: '2010-07-15',
        title: 'Inception',
        video: false,
        vote_average: 8.369,
        vote_count: 36104,
      },
      {
        id: 64956,
        title: 'Inception: The Cobol Job',
        original_title: 'Inception: The Cobol Job',
        release_date: '2010-12-07',
        popularity: 10.1,
        vote_average: 7.0,
        vote_count: 940,
      },
    ],
    total_pages: 1,
    total_results: 2,
  };
}

function inceptionDetailsBody(): unknown {
  return {
    id: 27205,
    imdb_id: 'tt1375666',
    title: 'Inception',
    original_title: 'Inception',
    overview:
      'Cobb, a skilled thief who commits corporate espionage by infiltrating the ' +
      'subconscious of his targets, is offered a chance to regain his old life.',
    tagline: 'Your mind is the scene of the crime.',
    release_date: '2010-07-15',
    runtime: 148,
    vote_average: 8.369,
    vote_count: 36104,
    popularity: 83.952,
    poster_path: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
    backdrop_path: '/s3TBrRGB1iav7gFOCNx3H31MoES.jpg',
    genres: [
      { id: 28, name: 'Action' },
      { id: 878, name: 'Science Fiction' },
      { id: 12, name: 'Adventure' },
    ],
    release_dates: {
      results: [
        { iso_3166_1: 'DE', release_dates: [{ certification: '12', type: 3 }] },
        {
          iso_3166_1: 'US',
          release_dates: [
            { certification: '', type: 1 },
            { certification: 'PG-13', type: 3 },
          ],
        },
      ],
    },
    credits: {
      cast: [
        {
          id: 6193,
          name: 'Leonardo DiCaprio',
          character: 'Dom Cobb',
          order: 0,
          profile_path: '/wo2hJpn04vbtmh0B9utCFdsQhxM.jpg',
        },
      ],
      crew: [{ id: 525, name: 'Christopher Nolan', job: 'Director', department: 'Directing' }],
    },
    external_ids: { imdb_id: 'tt1375666', wikidata_id: 'Q25188', facebook_id: 'inception' },
  };
}

function breakingBadSearchBody(): unknown {
  return {
    page: 1,
    results: [
      {
        id: 1396,
        name: 'Breaking Bad',
        original_name: 'Breaking Bad',
        first_air_date: '2008-01-20',
        popularity: 245.9,
        vote_average: 8.9,
        vote_count: 12000,
        poster_path: '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg',
        backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
        overview: 'A chemistry teacher diagnosed with cancer...',
      },
    ],
    total_pages: 1,
    total_results: 1,
  };
}

function breakingBadDetailsBody(): unknown {
  return {
    id: 1396,
    name: 'Breaking Bad',
    original_name: 'Breaking Bad',
    overview:
      'Walter White, a New Mexico chemistry teacher, is diagnosed with terminal ' +
      'lung cancer and teams up with a former student to secure his family’s future.',
    tagline: 'Change the equation.',
    first_air_date: '2008-01-20',
    episode_run_time: [45, 47],
    vote_average: 8.926,
    vote_count: 12000,
    poster_path: '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg',
    backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
    number_of_seasons: 5,
    genres: [
      { id: 18, name: 'Drama' },
      { id: 80, name: 'Crime' },
    ],
    seasons: [
      {
        id: 3577,
        season_number: 0,
        name: 'Specials',
        overview: '',
        episode_count: 11,
        poster_path: '/40dT79mDEZwXkQiZNBgSaydQFDP.jpg',
        air_date: '2009-02-17',
      },
      {
        id: 3572,
        season_number: 1,
        name: 'Season 1',
        overview: 'High school chemistry teacher Walter White’s life is suddenly transformed.',
        episode_count: 7,
        poster_path: '/1BP4xYv9ZG4ZVHkL7ocOziBbSYH.jpg',
        air_date: '2008-01-20',
      },
    ],
    content_ratings: {
      results: [
        { iso_3166_1: 'DE', rating: '16' },
        { iso_3166_1: 'US', rating: 'TV-MA' },
      ],
    },
    credits: { cast: [], crew: [] },
    external_ids: { imdb_id: 'tt0903747', tvdb_id: 81189 },
  };
}

function season1DetailsBody(): unknown {
  return {
    _id: '52542282760ee31328001a7b',
    id: 3572,
    season_number: 1,
    name: 'Season 1',
    overview: 'High school chemistry teacher Walter White’s life is suddenly transformed.',
    poster_path: '/1BP4xYv9ZG4ZVHkL7ocOziBbSYH.jpg',
    air_date: '2008-01-20',
    episodes: [
      {
        id: 62085,
        episode_number: 1,
        season_number: 1,
        name: 'Pilot',
        overview: 'A high school chemistry teacher learns he has terminal cancer.',
        still_path: '/ydlY3iPfeOAvu8gVqrxPoMvzNCn.jpg',
        air_date: '2008-01-20',
        runtime: 58,
        vote_average: 8.2,
        vote_count: 400,
      },
      {
        id: 62086,
        episode_number: 2,
        season_number: 1,
        name: "Cat's in the Bag...",
        overview: 'Walt and Jesse attempt to dispose of the evidence.',
        still_path: '/tjDNvbokPLtEnpFyFPyXMOd6Zr1.jpg',
        air_date: '2008-01-27',
        runtime: 48,
        vote_average: 8.0,
        vote_count: 350,
      },
      {
        id: 62087,
        episode_number: 3,
        season_number: 1,
        name: '...And the Bag’s in the River',
        overview: 'Walter fights with himself over his decision.',
        still_path: '/nvyLDzmoQjmpvTkoyBHKWSMSNqU.jpg',
        air_date: '2008-02-10',
        runtime: 48,
        vote_average: 8.1,
        vote_count: 330,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stubs global fetch with a pathname-keyed router of JSON bodies. Unknown
 * paths get TMDB's standard 404 body. A fresh Response is minted per call.
 */
function stubTmdb(handlers: Record<string, unknown>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const body = handlers[url.pathname];
    if (body === undefined) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            status_code: 34,
            status_message: 'The resource you requested could not be found.',
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubTmdbFailure(status: number) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status_message: 'oops' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function setApiKey(key: string): Promise<void> {
  await setSettings({ tmdbApiKey: key });
}

async function createLibrary(type: 'movies' | 'tv'): Promise<string> {
  const suffix = randomUUID();
  const library = await prisma.library.create({
    data: {
      name: `Library ${suffix}`,
      type,
      paths: { create: { path: `/media/${type}/${suffix}` } },
    },
  });
  return library.id;
}

async function createMovieItem(
  data: Partial<{ title: string; year: number | null; overview: string; contentRating: string; posterPath: string }> = {},
): Promise<string> {
  const libraryId = await createLibrary('movies');
  const item = await prisma.mediaItem.create({
    data: {
      libraryId,
      type: 'movie',
      title: data.title ?? 'Inception',
      sortTitle: (data.title ?? 'Inception').toLowerCase(),
      year: data.year === undefined ? 2010 : data.year,
      overview: data.overview ?? null,
      contentRating: data.contentRating ?? null,
      posterPath: data.posterPath ?? null,
    },
  });
  return item.id;
}

async function createShowItem(title = 'Breaking Bad', year: number | null = 2008): Promise<string> {
  const libraryId = await createLibrary('tv');
  const item = await prisma.mediaItem.create({
    data: {
      libraryId,
      type: 'show',
      title,
      sortTitle: title.toLowerCase(),
      year,
    },
  });
  return item.id;
}

// ---------------------------------------------------------------------------
// enrichMovieItem
// ---------------------------------------------------------------------------

describe('enrichMovieItem', () => {
  it('maps every TMDB field onto the MediaItem, including tmdb: URIs and US certification', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem();
    stubTmdb({
      '/3/search/movie': inceptionSearchBody(),
      '/3/movie/27205': inceptionDetailsBody(),
    });

    const result = await enrichMovieItem(mediaItemId);

    expect(result).toEqual({ status: 'updated', mediaItemId, tmdbId: 27205 });
    const item = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: mediaItemId },
      include: { genres: { orderBy: { name: 'asc' } } },
    });
    expect(item).toMatchObject({
      title: 'Inception', // scanner-owned, untouched
      overview: expect.stringContaining('Cobb, a skilled thief'),
      tagline: 'Your mind is the scene of the crime.',
      year: 2010,
      runtimeMs: 148 * 60_000,
      communityRating: 8.369,
      contentRating: 'PG-13', // US certification, not the DE "12"
      tmdbId: 27205,
      imdbId: 'tt1375666',
      posterPath: 'tmdb:/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
      backdropPath: 'tmdb:/s3TBrRGB1iav7gFOCNx3H31MoES.jpg',
    });
    expect(item.genres.map((genre) => genre.name)).toEqual([
      'Action',
      'Adventure',
      'Science Fiction',
    ]);
  });

  it('is idempotent for genres: enriching twice creates no duplicate Genre rows', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem();
    stubTmdb({
      '/3/search/movie': inceptionSearchBody(),
      '/3/movie/27205': inceptionDetailsBody(),
    });

    expect((await enrichMovieItem(mediaItemId)).status).toBe('updated');
    expect((await enrichMovieItem(mediaItemId)).status).toBe('updated');

    const genreNames = ['Action', 'Adventure', 'Science Fiction'];
    const genres = await prisma.genre.findMany({ where: { name: { in: genreNames } } });
    expect(genres).toHaveLength(3);
    const item = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: mediaItemId },
      include: { genres: true },
    });
    expect(item.genres).toHaveLength(3);
  });

  it('returns no-match and leaves the row untouched when nothing matches', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem({ title: 'Totally Unknown Home Video', year: 2023 });
    stubTmdb({ '/3/search/movie': inceptionSearchBody() }); // wrong titles only

    const before = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    const result = await enrichMovieItem(mediaItemId);

    expect(result).toEqual({ status: 'no-match', mediaItemId });
    const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    expect(after).toEqual(before);
  });

  it('returns no-api-key without any network call when the key is unset', async () => {
    await setApiKey('');
    const movieId = await createMovieItem();
    const showId = await createShowItem();
    const fetchMock = stubTmdb({});

    expect(await enrichMovieItem(movieId)).toEqual({ status: 'no-api-key', mediaItemId: movieId });
    expect(await enrichShowItem(showId)).toEqual({ status: 'no-api-key', mediaItemId: showId });
    expect(await enrichSeasonAndEpisodes(showId, 1396)).toEqual({
      status: 'no-api-key',
      mediaItemId: showId,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never clobbers existing values with TMDB’s empty/absent ones', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem({
      overview: 'Hand-written synopsis from an NFO file.',
      contentRating: 'PG',
      posterPath: '/local/poster.jpg',
    });
    const details = {
      id: 27205,
      title: 'Inception',
      overview: '', // TMDB has nothing -> must not erase the local overview
      tagline: null,
      release_date: '2010-07-15',
      runtime: 148,
      vote_average: 0, // 0 votes -> "no rating", must not overwrite
      poster_path: null,
      backdrop_path: null,
      genres: [],
      release_dates: { results: [] },
      external_ids: { imdb_id: null },
    };
    stubTmdb({ '/3/search/movie': inceptionSearchBody(), '/3/movie/27205': details });

    const result = await enrichMovieItem(mediaItemId);

    expect(result.status).toBe('updated');
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    expect(item.overview).toBe('Hand-written synopsis from an NFO file.');
    expect(item.contentRating).toBe('PG');
    expect(item.posterPath).toBe('/local/poster.jpg');
    expect(item.communityRating).toBeNull();
    // Real values still land.
    expect(item.tmdbId).toBe(27205);
    expect(item.runtimeMs).toBe(148 * 60_000);
  });

  it('returns error (and leaves the row untouched) when TMDB is down', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem();
    stubTmdbFailure(500);

    const before = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    const result = await enrichMovieItem(mediaItemId);

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toContain('500');
    expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } })).toEqual(
      before,
    );
  });

  it('returns error for a missing or non-movie item', async () => {
    await setApiKey(API_KEY);
    const showId = await createShowItem();
    const fetchMock = stubTmdb({});

    expect((await enrichMovieItem('nope-does-not-exist')).status).toBe('error');
    const wrongType = await enrichMovieItem(showId);
    expect(wrongType.status).toBe('error');
    if (wrongType.status === 'error') expect(wrongType.message).toContain('show');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// enrichMovieItem — TMDB auto-collections
// ---------------------------------------------------------------------------

function matrixCollection(posterPath: string | null): unknown {
  return {
    id: 2344,
    name: 'The Matrix Collection',
    poster_path: posterPath,
    backdrop_path: '/matrixBack.jpg',
  };
}

function matrixSearchBody(): unknown {
  return {
    page: 1,
    results: [
      {
        id: 603,
        title: 'The Matrix',
        original_title: 'The Matrix',
        release_date: '1999-03-30',
        vote_average: 8.2,
        vote_count: 24000,
      },
    ],
    total_results: 1,
  };
}

function matrixDetailsBody(collectionPoster: string | null = '/matrixColl.jpg'): unknown {
  return {
    id: 603,
    title: 'The Matrix',
    overview: 'A hacker discovers the true nature of his reality.',
    release_date: '1999-03-30',
    runtime: 136,
    vote_average: 8.2,
    poster_path: '/matrix.jpg',
    backdrop_path: '/matrixBd.jpg',
    belongs_to_collection: matrixCollection(collectionPoster),
    genres: [{ id: 28, name: 'Action' }],
  };
}

function reloadedSearchBody(): unknown {
  return {
    page: 1,
    results: [
      {
        id: 604,
        title: 'The Matrix Reloaded',
        original_title: 'The Matrix Reloaded',
        release_date: '2003-05-15',
        vote_average: 7.0,
        vote_count: 12000,
      },
    ],
    total_results: 1,
  };
}

function reloadedDetailsBody(): unknown {
  return {
    id: 604,
    title: 'The Matrix Reloaded',
    overview: 'Neo and the rebels race to protect Zion.',
    release_date: '2003-05-15',
    runtime: 138,
    vote_average: 7.0,
    poster_path: '/reloaded.jpg',
    belongs_to_collection: matrixCollection('/matrixColl.jpg'),
    genres: [{ id: 28, name: 'Action' }],
  };
}

describe('enrichMovieItem — auto-collections', () => {
  // Collections persist in the shared DB; reset them so each case is isolated.
  beforeEach(async () => {
    await prisma.collectionItem.deleteMany();
    await prisma.collection.deleteMany();
  });

  it('creates a tmdb collection and links the movie when belongs_to_collection is present', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem({ title: 'The Matrix', year: 1999 });
    stubTmdb({ '/3/search/movie': matrixSearchBody(), '/3/movie/603': matrixDetailsBody() });

    expect((await enrichMovieItem(mediaItemId)).status).toBe('updated');

    const collection = await prisma.collection.findUniqueOrThrow({
      where: { tmdbCollectionId: 2344 },
      include: { items: true },
    });
    expect(collection).toMatchObject({
      name: 'The Matrix Collection',
      sortName: 'Matrix Collection, The',
      source: 'tmdb',
      posterPath: 'tmdb:/matrixColl.jpg',
    });
    expect(collection.items.map((entry) => entry.mediaItemId)).toEqual([mediaItemId]);
  });

  it('creates no collection when the movie has no belongs_to_collection', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem();
    stubTmdb({ '/3/search/movie': inceptionSearchBody(), '/3/movie/27205': inceptionDetailsBody() });

    expect((await enrichMovieItem(mediaItemId)).status).toBe('updated');
    expect(await prisma.collection.count()).toBe(0);
  });

  it('is idempotent: re-enriching the same movie adds no duplicate membership', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createMovieItem({ title: 'The Matrix', year: 1999 });
    stubTmdb({ '/3/search/movie': matrixSearchBody(), '/3/movie/603': matrixDetailsBody() });

    await enrichMovieItem(mediaItemId);
    await enrichMovieItem(mediaItemId);

    expect(await prisma.collection.count()).toBe(1);
    const members = await prisma.collectionItem.findMany({ where: { mediaItemId } });
    expect(members).toHaveLength(1);
  });

  it('reuses the same collection for a second member and appends it in order', async () => {
    await setApiKey(API_KEY);
    const first = await createMovieItem({ title: 'The Matrix', year: 1999 });
    stubTmdb({ '/3/search/movie': matrixSearchBody(), '/3/movie/603': matrixDetailsBody() });
    await enrichMovieItem(first);

    const second = await createMovieItem({ title: 'The Matrix Reloaded', year: 2003 });
    stubTmdb({ '/3/search/movie': reloadedSearchBody(), '/3/movie/604': reloadedDetailsBody() });
    await enrichMovieItem(second);

    const collections = await prisma.collection.findMany({
      where: { tmdbCollectionId: 2344 },
      include: { items: { orderBy: { order: 'asc' } } },
    });
    expect(collections).toHaveLength(1);
    expect(collections[0]?.items.map((entry) => entry.mediaItemId)).toEqual([first, second]);
  });

  it('fills a missing collection poster on a later pass without overwriting an existing one', async () => {
    await setApiKey(API_KEY);
    const first = await createMovieItem({ title: 'The Matrix', year: 1999 });
    stubTmdb({ '/3/search/movie': matrixSearchBody(), '/3/movie/603': matrixDetailsBody(null) });
    await enrichMovieItem(first);
    expect(
      (await prisma.collection.findUniqueOrThrow({ where: { tmdbCollectionId: 2344 } })).posterPath,
    ).toBeNull();

    const second = await createMovieItem({ title: 'The Matrix Reloaded', year: 2003 });
    stubTmdb({ '/3/search/movie': reloadedSearchBody(), '/3/movie/604': reloadedDetailsBody() });
    await enrichMovieItem(second);
    expect(
      (await prisma.collection.findUniqueOrThrow({ where: { tmdbCollectionId: 2344 } })).posterPath,
    ).toBe('tmdb:/matrixColl.jpg');
  });
});

// ---------------------------------------------------------------------------
// enrichShowItem
// ---------------------------------------------------------------------------

describe('enrichShowItem', () => {
  it('maps show fields (content_ratings, episode_run_time) and returns the season list', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createShowItem();
    stubTmdb({
      '/3/search/tv': breakingBadSearchBody(),
      '/3/tv/1396': breakingBadDetailsBody(),
    });

    const result = await enrichShowItem(mediaItemId);

    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    expect(result.tmdbId).toBe(1396);
    expect(result.seasons).toEqual([
      {
        seasonNumber: 0,
        name: 'Specials',
        overview: undefined,
        episodeCount: 11,
        posterUri: 'tmdb:/40dT79mDEZwXkQiZNBgSaydQFDP.jpg',
        airDate: '2009-02-17',
        year: 2009,
      },
      {
        seasonNumber: 1,
        name: 'Season 1',
        overview: expect.stringContaining('Walter White'),
        episodeCount: 7,
        posterUri: 'tmdb:/1BP4xYv9ZG4ZVHkL7ocOziBbSYH.jpg',
        airDate: '2008-01-20',
        year: 2008,
      },
    ]);

    const item = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: mediaItemId },
      include: { genres: { orderBy: { name: 'asc' } } },
    });
    expect(item).toMatchObject({
      overview: expect.stringContaining('Walter White'),
      tagline: 'Change the equation.',
      year: 2008,
      runtimeMs: 45 * 60_000, // episode_run_time[0]
      communityRating: 8.926,
      contentRating: 'TV-MA', // US rating, not the DE "16"
      tmdbId: 1396,
      imdbId: 'tt0903747',
      posterPath: 'tmdb:/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg',
      backdropPath: 'tmdb:/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
    });
    expect(item.genres.map((genre) => genre.name)).toEqual(['Crime', 'Drama']);
  });

  it('returns no-match for a deliberately wrong-titled result set', async () => {
    await setApiKey(API_KEY);
    const mediaItemId = await createShowItem('Cooking Good', 2008);
    stubTmdb({ '/3/search/tv': breakingBadSearchBody() });

    expect(await enrichShowItem(mediaItemId)).toEqual({ status: 'no-match', mediaItemId });
  });
});

// ---------------------------------------------------------------------------
// enrichSeasonAndEpisodes
// ---------------------------------------------------------------------------

describe('enrichSeasonAndEpisodes', () => {
  it('enriches existing season and episode rows, skipping unknown ones', async () => {
    await setApiKey(API_KEY);
    const showId = await createShowItem();
    const show = await prisma.mediaItem.findUniqueOrThrow({ where: { id: showId } });
    const season1 = await prisma.mediaItem.create({
      data: {
        libraryId: show.libraryId,
        parentId: showId,
        type: 'season',
        title: 'Season 1',
        sortTitle: 'season 1',
        seasonNumber: 1,
      },
    });
    // A season TMDB does not know: must be skipped via its 404, not fail.
    await prisma.mediaItem.create({
      data: {
        libraryId: show.libraryId,
        parentId: showId,
        type: 'season',
        title: 'Season 99',
        sortTitle: 'season 99',
        seasonNumber: 99,
      },
    });
    const makeEpisode = (episodeNumber: number): Promise<{ id: string }> =>
      prisma.mediaItem.create({
        data: {
          libraryId: show.libraryId,
          parentId: season1.id,
          type: 'episode',
          title: `Episode ${episodeNumber}`,
          sortTitle: `episode ${episodeNumber}`,
          seasonNumber: 1,
          episodeNumber,
        },
      });
    const episode1 = await makeEpisode(1);
    const episode2 = await makeEpisode(2);
    // A local episode TMDB's season listing does not have.
    const episode42 = await makeEpisode(42);

    stubTmdb({ '/3/tv/1396/season/1': season1DetailsBody() });

    const result = await enrichSeasonAndEpisodes(showId, 1396);

    expect(result).toEqual({
      status: 'updated',
      mediaItemId: showId,
      seasonsUpdated: 1,
      episodesUpdated: 2,
    });

    const seasonRow = await prisma.mediaItem.findUniqueOrThrow({ where: { id: season1.id } });
    expect(seasonRow).toMatchObject({
      title: 'Season 1', // scanner-owned, untouched
      overview: expect.stringContaining('Walter White'),
      year: 2008,
      posterPath: 'tmdb:/1BP4xYv9ZG4ZVHkL7ocOziBbSYH.jpg',
    });

    const episode1Row = await prisma.mediaItem.findUniqueOrThrow({ where: { id: episode1.id } });
    expect(episode1Row).toMatchObject({
      title: 'Episode 1', // scanner-owned, untouched
      overview: expect.stringContaining('terminal cancer'),
      runtimeMs: 58 * 60_000,
      communityRating: 8.2,
      year: 2008,
      posterPath: 'tmdb:/ydlY3iPfeOAvu8gVqrxPoMvzNCn.jpg',
    });
    const episode2Row = await prisma.mediaItem.findUniqueOrThrow({ where: { id: episode2.id } });
    expect(episode2Row.runtimeMs).toBe(48 * 60_000);

    // The unmatched local episode is untouched.
    const episode42Row = await prisma.mediaItem.findUniqueOrThrow({ where: { id: episode42.id } });
    expect(episode42Row.overview).toBeNull();
    expect(episode42Row.runtimeMs).toBeNull();
  });

  it('returns error when TMDB fails mid-run (non-404)', async () => {
    await setApiKey(API_KEY);
    const showId = await createShowItem();
    const show = await prisma.mediaItem.findUniqueOrThrow({ where: { id: showId } });
    await prisma.mediaItem.create({
      data: {
        libraryId: show.libraryId,
        parentId: showId,
        type: 'season',
        title: 'Season 1',
        sortTitle: 'season 1',
        seasonNumber: 1,
      },
    });
    stubTmdbFailure(503);

    const result = await enrichSeasonAndEpisodes(showId, 1396);

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toContain('503');
  });
});
