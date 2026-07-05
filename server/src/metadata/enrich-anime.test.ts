import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import { enrichAnimeItem } from './enrich-anime.js';

// Enrichment round-trips against a real temporary SQLite database (created by
// applying the committed migrations, same approach as enrich-tmdb.test.ts).
// The global fetch is always stubbed with inline AniList-shaped fixtures — no
// live AniList calls, ever.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-enrich-anime-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;

  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures (realistic AniList response shapes, inline)
// ---------------------------------------------------------------------------

function cowboyBebopMedia(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 1,
    title: { romaji: 'Cowboy Bebop', english: 'Cowboy Bebop', native: 'カウボーイビバップ' },
    synonyms: [],
    seasonYear: 1998,
    format: 'TV',
    episodes: 26,
    duration: 24,
    averageScore: 86,
    popularity: 400000,
    genres: ['Action', 'Adventure', 'Sci-Fi'],
    description: 'Enter the bounty hunters &amp; <i>their</i> exploits.<br><br>Woolong bounties await.',
    coverImage: {
      large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.png',
      extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/extraLarge/bx1.png',
    },
    bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1.jpg',
    startDate: { year: 1998, month: 4, day: 3 },
    ...overrides,
  };
}

function searchBody(...mediaNodes: unknown[]): unknown {
  return { data: { Page: { media: mediaNodes } } };
}

/** Stubs global fetch to answer every AniList POST with `body`. */
function stubAnilist(body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubAnilistFailure(status: number) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ errors: [{ message: 'oops' }] }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function createAnimeItem(
  data: Partial<{
    title: string;
    year: number | null;
    type: 'movie' | 'show' | 'episode';
    overview: string | null;
    posterPath: string | null;
  }> = {},
): Promise<string> {
  const suffix = randomUUID();
  const library = await prisma.library.create({
    data: {
      name: `Anime ${suffix}`,
      type: 'anime',
      paths: { create: { path: `/media/anime/${suffix}` } },
    },
  });
  const title = data.title ?? 'Cowboy Bebop';
  const item = await prisma.mediaItem.create({
    data: {
      libraryId: library.id,
      type: data.type ?? 'show',
      title,
      sortTitle: title.toLowerCase(),
      year: data.year === undefined ? 1998 : data.year,
      overview: data.overview ?? null,
      posterPath: data.posterPath ?? null,
    },
  });
  return item.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichAnimeItem', () => {
  it('maps AniList fields onto the MediaItem, incl. score/10 and anilist: URIs', async () => {
    const mediaItemId = await createAnimeItem();
    stubAnilist(searchBody(cowboyBebopMedia()));

    const result = await enrichAnimeItem(mediaItemId);

    expect(result).toEqual({ status: 'updated', source: 'anilist', mediaItemId, anilistId: 1 });
    const item = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: mediaItemId },
      include: { genres: { orderBy: { name: 'asc' } } },
    });
    expect(item).toMatchObject({
      title: 'Cowboy Bebop', // scanner-owned, untouched
      overview: expect.stringContaining('bounty hunters & their exploits'),
      year: 1998,
      runtimeMs: 24 * 60_000,
      communityRating: 8.6, // averageScore 86 / 10
      anilistId: 1,
      posterPath: 'anilist:https://s4.anilist.co/file/anilistcdn/media/anime/cover/extraLarge/bx1.png',
      backdropPath: 'anilist:https://s4.anilist.co/file/anilistcdn/media/anime/banner/1.jpg',
    });
    // description HTML is stripped before storage.
    expect(item.overview).not.toContain('<');
    expect(item.genres.map((genre) => genre.name)).toEqual(['Action', 'Adventure', 'Sci-Fi']);
  });

  it('falls back to coverImage.large when extraLarge is absent', async () => {
    const mediaItemId = await createAnimeItem();
    stubAnilist(
      searchBody(
        cowboyBebopMedia({
          coverImage: {
            large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/only.png',
            extraLarge: null,
          },
        }),
      ),
    );

    await enrichAnimeItem(mediaItemId);

    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    expect(item.posterPath).toBe(
      'anilist:https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/only.png',
    );
  });

  it('is idempotent for genres: enriching twice creates no duplicate Genre rows', async () => {
    const mediaItemId = await createAnimeItem();
    stubAnilist(searchBody(cowboyBebopMedia()));

    expect((await enrichAnimeItem(mediaItemId)).status).toBe('updated');
    expect((await enrichAnimeItem(mediaItemId)).status).toBe('updated');

    const item = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: mediaItemId },
      include: { genres: true },
    });
    expect(item.genres).toHaveLength(3);
    const genres = await prisma.genre.findMany({
      where: { name: { in: ['Action', 'Adventure', 'Sci-Fi'] } },
    });
    expect(genres).toHaveLength(3);
  });

  it('returns no-match and leaves the row untouched when nothing matches', async () => {
    const mediaItemId = await createAnimeItem({ title: 'Totally Made Up Anime', year: 2024 });
    stubAnilist(searchBody(cowboyBebopMedia())); // wrong title only

    const before = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    const result = await enrichAnimeItem(mediaItemId);

    expect(result).toEqual({ status: 'no-match', source: 'anilist', mediaItemId });
    const after = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    expect(after).toEqual(before);
  });

  it('never clobbers an existing overview/poster with AniList empties', async () => {
    const mediaItemId = await createAnimeItem({
      overview: 'Hand-written synopsis from an NFO file.',
      posterPath: '/local/poster.jpg',
    });
    stubAnilist(
      searchBody(
        cowboyBebopMedia({
          description: '', // AniList has nothing -> must not erase the local overview
          averageScore: 0, // unrated -> must not set communityRating
          coverImage: { large: null, extraLarge: null },
          bannerImage: null,
        }),
      ),
    );

    const result = await enrichAnimeItem(mediaItemId);

    expect(result.status).toBe('updated');
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    expect(item.overview).toBe('Hand-written synopsis from an NFO file.');
    expect(item.posterPath).toBe('/local/poster.jpg');
    expect(item.communityRating).toBeNull();
    // Real values still land.
    expect(item.anilistId).toBe(1);
    expect(item.runtimeMs).toBe(24 * 60_000);
  });

  it('stores duration on a film-type item too (duration is the full runtime)', async () => {
    const mediaItemId = await createAnimeItem({
      title: 'Your Name',
      year: 2016,
      type: 'movie',
    });
    stubAnilist(
      searchBody({
        id: 21519,
        title: { romaji: 'Kimi no Na wa.', english: 'Your Name.', native: '君の名は。' },
        synonyms: ['Your Name'],
        seasonYear: 2016,
        format: 'MOVIE',
        episodes: 1,
        duration: 107,
        averageScore: 85,
        genres: ['Romance', 'Drama'],
        description: 'Two strangers find themselves linked.',
        coverImage: { large: null, extraLarge: 'https://s4.anilist.co/file/x.png' },
        bannerImage: null,
        startDate: { year: 2016, month: 8, day: 26 },
      }),
    );

    const result = await enrichAnimeItem(mediaItemId);

    expect(result).toMatchObject({ status: 'updated', anilistId: 21519 });
    const item = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    expect(item.runtimeMs).toBe(107 * 60_000);
    expect(item.communityRating).toBe(8.5);
  });

  it('returns error (leaving the row untouched) when AniList is down', async () => {
    const mediaItemId = await createAnimeItem();
    stubAnilistFailure(500);

    const before = await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } });
    const result = await enrichAnimeItem(mediaItemId);

    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toContain('500');
    expect(await prisma.mediaItem.findUniqueOrThrow({ where: { id: mediaItemId } })).toEqual(before);
  });

  it('returns error for a missing item without a network call', async () => {
    const fetchMock = stubAnilist(searchBody());
    const result = await enrichAnimeItem('does-not-exist');
    expect(result.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
