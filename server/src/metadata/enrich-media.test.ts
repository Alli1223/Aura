import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LibraryType } from '../db/constants.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import { clearSettingsCache, setSettings } from '../lib/settings.js';
import { enrichItem } from './enrich-media.js';

// The orchestrator drives the AniList and TMDB agents against a real temporary
// SQLite database. A single fetch stub routes by hostname — graphql.anilist.co
// vs api.themoviedb.org — so a single test can exercise the whole fallback
// chain. No live network calls, ever.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMDB_KEY = '0123456789abcdef0123456789abcdef';

let tempDir: string;
let mediaRoot: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-enrich-media-test-'));
  mediaRoot = path.join(tempDir, 'media');
  await mkdir(mediaRoot, { recursive: true });
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
  clearSettingsCache();
  await setSettings({ tmdbApiKey: TMDB_KEY });
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyAnilist(): unknown {
  return { data: { Page: { media: [] } } };
}

function cowboyBebopAnilist(): unknown {
  return {
    data: {
      Page: {
        media: [
          {
            id: 1,
            title: { romaji: 'Cowboy Bebop', english: 'Cowboy Bebop', native: 'カウボーイビバップ' },
            synonyms: [],
            seasonYear: 1998,
            format: 'TV',
            episodes: 26,
            duration: 24,
            averageScore: 86,
            popularity: 400000,
            genres: ['Action', 'Sci-Fi'],
            description: 'Bounty hunters chase their pasts.',
            coverImage: { large: null, extraLarge: 'https://s4.anilist.co/file/cover.png' },
            bannerImage: 'https://s4.anilist.co/file/banner.jpg',
            startDate: { year: 1998, month: 4, day: 3 },
          },
        ],
      },
    },
  };
}

function movieSearch(id: number, title: string, year: string): unknown {
  return {
    page: 1,
    results: [
      {
        id,
        title,
        original_title: title,
        release_date: year,
        popularity: 50,
        vote_average: 8,
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        overview: 'search overview',
      },
    ],
  };
}

function movieDetails(id: number, title: string, year: string): unknown {
  return {
    id,
    title,
    original_title: title,
    overview: 'A detailed TMDB synopsis.',
    tagline: '',
    release_date: year,
    runtime: 120,
    vote_average: 8,
    poster_path: '/poster.jpg',
    backdrop_path: '/backdrop.jpg',
    genres: [{ id: 16, name: 'Animation' }],
    release_dates: { results: [] },
    external_ids: { imdb_id: 'tt0000000' },
  };
}

/** Routes fetch to AniList (by hostname) or TMDB (by pathname). */
function stubRouter(opts: { anilist?: unknown; tmdb?: Record<string, unknown> }) {
  const anilistBody = opts.anilist ?? emptyAnilist();
  const tmdb = opts.tmdb ?? {};
  const calls = { anilist: 0, tmdb: 0 };
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === 'graphql.anilist.co') {
      calls.anilist += 1;
      return Promise.resolve(jsonResponse(anilistBody));
    }
    calls.tmdb += 1;
    const body = tmdb[url.pathname];
    if (body === undefined) {
      return Promise.resolve(jsonResponse({ status_code: 34, status_message: 'not found' }, 404));
    }
    return Promise.resolve(jsonResponse(body));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

async function createItem(
  libraryType: LibraryType,
  itemType: 'movie' | 'show',
  title: string,
  year: number | null,
): Promise<string> {
  const suffix = randomUUID();
  const library = await prisma.library.create({
    data: {
      name: `Lib ${suffix}`,
      type: libraryType,
      paths: { create: { path: `/media/${libraryType}/${suffix}` } },
    },
  });
  const item = await prisma.mediaItem.create({
    data: {
      libraryId: library.id,
      type: itemType,
      title,
      sortTitle: title.toLowerCase(),
      year,
    },
  });
  return item.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichItem — anime library', () => {
  it('uses AniList first and reports source "anilist" on a match', async () => {
    const id = await createItem('anime', 'show', 'Cowboy Bebop', 1998);
    const { calls } = stubRouter({ anilist: cowboyBebopAnilist() });

    const result = await enrichItem(id, 'anime');

    expect(result).toEqual({ status: 'updated', source: 'anilist', mediaItemId: id, anilistId: 1 });
    // TMDB is never consulted once AniList matches.
    expect(calls.tmdb).toBe(0);
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    expect(item.anilistId).toBe(1);
    expect(item.tmdbId).toBeNull();
  });

  it('falls through to TMDB (source "tmdb") when AniList has no match', async () => {
    const id = await createItem('anime', 'movie', 'Spirited Away', 2001);
    const { calls } = stubRouter({
      anilist: emptyAnilist(),
      tmdb: {
        '/3/search/movie': movieSearch(129, 'Spirited Away', '2001-07-20'),
        '/3/movie/129': movieDetails(129, 'Spirited Away', '2001-07-20'),
      },
    });

    const result = await enrichItem(id, 'anime');

    expect(result).toEqual({ status: 'updated', source: 'tmdb', mediaItemId: id, tmdbId: 129 });
    expect(calls.anilist).toBeGreaterThan(0); // AniList was tried first
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    expect(item.tmdbId).toBe(129);
    expect(item.overview).toBe('A detailed TMDB synopsis.');
  });

  it('returns filename-fallback and preserves scanner fields when both agents miss', async () => {
    const id = await createItem('anime', 'movie', 'Nonexistent Feature', 2024);
    stubRouter({
      anilist: emptyAnilist(),
      // TMDB returns a wrong-titled result the matcher will reject.
      tmdb: { '/3/search/movie': movieSearch(1, 'Something Else Entirely', '2024-01-01') },
    });

    const before = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    const result = await enrichItem(id, 'anime');

    expect(result).toEqual({ status: 'filename-fallback', source: 'filename', mediaItemId: id });
    const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    // Filename-derived fields are left exactly as the scanner set them.
    expect(after.title).toBe('Nonexistent Feature');
    expect(after.year).toBe(2024);
    expect(after).toEqual(before);
  });
});

describe('enrichItem — non-anime library', () => {
  it('goes straight to TMDB (source "tmdb") without touching AniList', async () => {
    const id = await createItem('movies', 'movie', 'Inception', 2010);
    const { calls } = stubRouter({
      tmdb: {
        '/3/search/movie': movieSearch(27205, 'Inception', '2010-07-15'),
        '/3/movie/27205': movieDetails(27205, 'Inception', '2010-07-15'),
      },
    });

    const result = await enrichItem(id, 'movies');

    expect(result).toEqual({ status: 'updated', source: 'tmdb', mediaItemId: id, tmdbId: 27205 });
    // AniList is only for anime libraries.
    expect(calls.anilist).toBe(0);
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    expect(item.tmdbId).toBe(27205);
    expect(item.anilistId).toBeNull();
  });

  it('returns filename-fallback when TMDB has no match', async () => {
    const id = await createItem('movies', 'movie', 'Nonexistent Feature', 2024);
    stubRouter({ tmdb: { '/3/search/movie': movieSearch(1, 'Something Else', '2024-01-01') } });

    const result = await enrichItem(id, 'movies');

    expect(result).toEqual({ status: 'filename-fallback', source: 'filename', mediaItemId: id });
  });

  it('returns an error result for a missing MediaItem', async () => {
    stubRouter({});
    const result = await enrichItem('does-not-exist', 'movies');
    expect(result).toEqual({
      status: 'error',
      source: 'none',
      mediaItemId: 'does-not-exist',
      message: 'MediaItem not found',
    });
  });
});

// ---------------------------------------------------------------------------
// Local sidecar precedence
// ---------------------------------------------------------------------------

const NFO_TITLE = 'Local NFO Title';
const NFO_PLOT = 'Overview curated in the local NFO.';

/** Writes a movie .nfo without genres/artwork so those still fall back to TMDB. */
function movieNfo(): string {
  return (
    `<movie><title>${NFO_TITLE}</title><plot>${NFO_PLOT}</plot>` +
    `<year>1999</year><mpaa>Rated R</mpaa></movie>`
  );
}

/**
 * Creates a movies library rooted at a fresh folder inside the media root, a
 * movie MediaItem and its MediaFile. Returns the item id and the movie dir so
 * a test can drop sidecar files next to the video.
 */
async function createMovieWithFile(
  title: string,
  year: number,
): Promise<{ id: string; dir: string; videoPath: string }> {
  const suffix = randomUUID();
  const dir = path.join(mediaRoot, `${title} (${year}) ${suffix}`);
  await mkdir(dir, { recursive: true });
  const videoPath = path.join(dir, `${title}.mkv`);
  await writeFile(videoPath, 'video-bytes');

  const library = await prisma.library.create({
    data: { name: `Lib ${suffix}`, type: 'movies', paths: { create: { path: mediaRoot } } },
  });
  const item = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title, sortTitle: title.toLowerCase(), year },
  });
  await prisma.mediaFile.create({
    data: {
      mediaItemId: item.id,
      path: videoPath,
      size: BigInt(11),
      mtimeMs: BigInt(1),
      status: 'available',
    },
  });
  return { id: item.id, dir, videoPath };
}

function tmdbForInception(): Record<string, unknown> {
  return {
    '/3/search/movie': movieSearch(27205, 'Inception', '2010-07-15'),
    '/3/movie/27205': movieDetails(27205, 'Inception', '2010-07-15'),
  };
}

describe('enrichItem — local NFO precedence', () => {
  it('overlays NFO fields over online metadata and reports source "local+tmdb"', async () => {
    const { id, dir } = await createMovieWithFile('Inception', 2010);
    await writeFile(path.join(dir, 'Inception.nfo'), movieNfo());
    stubRouter({ tmdb: tmdbForInception() });

    const result = await enrichItem(id, 'movies', undefined, [mediaRoot]);

    expect(result).toEqual({ status: 'updated', source: 'local+tmdb', mediaItemId: id, tmdbId: 27205 });
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id }, include: { genres: true } });
    // NFO wins for the fields it provides...
    expect(item.title).toBe(NFO_TITLE);
    expect(item.overview).toBe(NFO_PLOT);
    expect(item.contentRating).toBe('R');
    // ...online fills the gaps the NFO left (genres, tmdbId, poster).
    expect(item.tmdbId).toBe(27205);
    expect(item.genres.map((g) => g.name)).toContain('Animation');
    expect(item.posterPath).toBe('tmdb:/poster.jpg');
  });

  it('lets local artwork override the online poster/backdrop paths', async () => {
    const { id, dir } = await createMovieWithFile('Inception', 2010);
    await writeFile(path.join(dir, 'Inception.nfo'), movieNfo());
    const poster = path.join(dir, 'poster.jpg');
    const fanart = path.join(dir, 'fanart.jpg');
    await writeFile(poster, 'p');
    await writeFile(fanart, 'f');
    stubRouter({ tmdb: tmdbForInception() });

    const result = await enrichItem(id, 'movies', undefined, [mediaRoot]);

    expect(result.source).toBe('local+tmdb');
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    expect(item.posterPath).toBe(poster);
    expect(item.backdropPath).toBe(fanart);
  });

  it('reports source "local" when an NFO is present but online finds no match', async () => {
    const { id, dir } = await createMovieWithFile('Obscure Film', 2001);
    await writeFile(path.join(dir, 'Obscure Film.nfo'), movieNfo());
    // TMDB returns a wrong-titled result the matcher rejects.
    stubRouter({ tmdb: { '/3/search/movie': movieSearch(7, 'Totally Different', '2001-01-01') } });

    const result = await enrichItem(id, 'movies', undefined, [mediaRoot]);

    expect(result).toEqual({ status: 'updated', source: 'local', mediaItemId: id });
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    expect(item.title).toBe(NFO_TITLE);
    expect(item.overview).toBe(NFO_PLOT);
  });

  it('is identical to online-only enrichment when no sidecars exist (regression)', async () => {
    const { id } = await createMovieWithFile('Inception', 2010);
    stubRouter({ tmdb: tmdbForInception() });

    const result = await enrichItem(id, 'movies', undefined, [mediaRoot]);

    expect(result).toEqual({ status: 'updated', source: 'tmdb', mediaItemId: id, tmdbId: 27205 });
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id } });
    // Scanner title preserved; TMDB overview applied.
    expect(item.title).toBe('Inception');
    expect(item.overview).toBe('A detailed TMDB synopsis.');
  });

  it('reads tvshow.nfo for a show via its episode files (source "local")', async () => {
    const suffix = randomUUID();
    const showDir = path.join(mediaRoot, `Cowboy Bebop ${suffix}`);
    const seasonDir = path.join(showDir, 'Season 01');
    await mkdir(seasonDir, { recursive: true });
    await writeFile(
      path.join(showDir, 'tvshow.nfo'),
      `<tvshow><title>${NFO_TITLE}</title><plot>${NFO_PLOT}</plot><premiered>1998-04-03</premiered></tvshow>`,
    );
    const episodeVideo = path.join(seasonDir, 'Cowboy Bebop - S01E01.mkv');
    await writeFile(episodeVideo, 'v');

    const library = await prisma.library.create({
      data: { name: `Lib ${suffix}`, type: 'tv', paths: { create: { path: mediaRoot } } },
    });
    const show = await prisma.mediaItem.create({
      data: { libraryId: library.id, type: 'show', title: 'Cowboy Bebop', sortTitle: 'cowboy bebop' },
    });
    const season = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'season',
        parentId: show.id,
        title: 'Season 1',
        sortTitle: 'season 1',
        seasonNumber: 1,
      },
    });
    const episode = await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        type: 'episode',
        parentId: season.id,
        title: 'Episode 1',
        sortTitle: 'episode 1',
        seasonNumber: 1,
        episodeNumber: 1,
      },
    });
    await prisma.mediaFile.create({
      data: {
        mediaItemId: episode.id,
        path: episodeVideo,
        size: BigInt(1),
        mtimeMs: BigInt(1),
        status: 'available',
      },
    });

    // No TMDB match, so only the local tvshow.nfo contributes.
    stubRouter({ tmdb: { '/3/search/tv': { page: 1, results: [] } } });

    const result = await enrichItem(show.id, 'tv', undefined, [mediaRoot]);

    expect(result).toEqual({ status: 'updated', source: 'local', mediaItemId: show.id });
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id: show.id } });
    expect(item.title).toBe(NFO_TITLE);
    expect(item.overview).toBe(NFO_PLOT);
    expect(item.year).toBe(1998);
  });
});
