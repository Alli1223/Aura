import { describe, expect, it } from 'vitest';

import type { AnilistMedia } from './anilist-client.js';
import { animeTitles, animeYear, pickBestAnime } from './anilist-matcher.js';

function media(
  partial: Partial<AnilistMedia> & { id: number },
): AnilistMedia {
  return {
    title: { romaji: null, english: null, native: null },
    synonyms: [],
    seasonYear: null,
    format: 'TV',
    episodes: null,
    duration: null,
    averageScore: 70,
    popularity: 1000,
    genres: [],
    description: null,
    coverImage: { large: null, extraLarge: null },
    bannerImage: null,
    startDate: { year: null, month: null, day: null },
    ...partial,
  };
}

describe('animeTitles / animeYear', () => {
  it('collects romaji, english, native and synonyms', () => {
    const m = media({
      id: 1,
      title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' },
      synonyms: ['AoT', 'SnK'],
    });
    expect(animeTitles(m)).toEqual([
      'Shingeki no Kyojin',
      'Attack on Titan',
      '進撃の巨人',
      'AoT',
      'SnK',
    ]);
  });

  it('prefers seasonYear, falling back to startDate.year', () => {
    expect(animeYear(media({ id: 1, seasonYear: 2013 }))).toBe(2013);
    expect(
      animeYear(media({ id: 1, seasonYear: null, startDate: { year: 2009, month: 4, day: 5 } })),
    ).toBe(2009);
    expect(animeYear(media({ id: 1, seasonYear: null, startDate: { year: null, month: null, day: null } }))).toBeUndefined();
  });
});

describe('pickBestAnime', () => {
  it('matches on romaji when the query is the romaji title', () => {
    const m = media({
      id: 16498,
      title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' },
      seasonYear: 2013,
    });
    expect(pickBestAnime([m], 'Shingeki no Kyojin', 2013)?.id).toBe(16498);
  });

  it('matches on the english title when the query is english', () => {
    const m = media({
      id: 16498,
      title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' },
      seasonYear: 2013,
    });
    expect(pickBestAnime([m], 'Attack on Titan', 2013)?.id).toBe(16498);
  });

  it('matches on the native title and on a synonym', () => {
    const m = media({
      id: 21,
      title: { romaji: 'One Piece', english: 'One Piece', native: 'ONE PIECE' },
      synonyms: ['OP'],
      seasonYear: 1999,
    });
    expect(pickBestAnime([m], 'ONE PIECE', 1999)?.id).toBe(21);
    expect(pickBestAnime([m], 'op', 1999)?.id).toBe(21);
  });

  it('disambiguates two same-titled entries by year', () => {
    const original = media({
      id: 30,
      title: { romaji: 'Fullmetal Alchemist', english: 'Fullmetal Alchemist', native: null },
      seasonYear: 2003,
      averageScore: 80,
    });
    const brotherhood = media({
      id: 5114,
      title: { romaji: 'Fullmetal Alchemist', english: 'Fullmetal Alchemist', native: null },
      seasonYear: 2009,
      averageScore: 90,
    });

    // Even though brotherhood scores higher, the exact-year match wins.
    expect(pickBestAnime([brotherhood, original], 'Fullmetal Alchemist', 2003)?.id).toBe(30);
    expect(pickBestAnime([original, brotherhood], 'Fullmetal Alchemist', 2009)?.id).toBe(5114);
  });

  it('accepts a year within ±1 (regional/broadcast offsets)', () => {
    const m = media({
      id: 9253,
      title: { romaji: 'Steins;Gate', english: 'Steins;Gate', native: null },
      seasonYear: 2011,
    });
    expect(pickBestAnime([m], 'Steins Gate', 2012)?.id).toBe(9253);
    expect(pickBestAnime([m], 'Steins;Gate', 2010)?.id).toBe(9253);
  });

  it('normalises diacritics and punctuation before comparing', () => {
    const m = media({
      id: 100,
      title: { romaji: 'Kimi no Na wa.', english: 'Your Name.', native: '君の名は。' },
      seasonYear: 2016,
    });
    expect(pickBestAnime([m], 'your name', 2016)?.id).toBe(100);
    expect(pickBestAnime([m], 'Kimi no Na wa', 2016)?.id).toBe(100);
  });

  it('breaks title-only ties by averageScore then popularity', () => {
    const low = media({
      id: 1,
      title: { romaji: 'Twin Title', english: null, native: null },
      seasonYear: 2000,
      averageScore: 60,
      popularity: 5000,
    });
    const high = media({
      id: 2,
      title: { romaji: 'Twin Title', english: null, native: null },
      seasonYear: 2018,
      averageScore: 88,
      popularity: 100,
    });
    // No local year: the higher-scored one wins despite lower popularity.
    expect(pickBestAnime([low, high], 'Twin Title')?.id).toBe(2);
  });

  it('returns null when nothing matches the normalised title (no bad guesses)', () => {
    const wrong = [
      media({ id: 1, title: { romaji: 'Naruto', english: 'Naruto', native: null }, averageScore: 95, popularity: 999999 }),
      media({ id: 2, title: { romaji: 'Bleach', english: 'Bleach', native: null }, averageScore: 90 }),
    ];
    expect(pickBestAnime(wrong, 'Totally Made Up Show', 2020)).toBeNull();
    expect(pickBestAnime([], 'Anything', 2020)).toBeNull();
    expect(pickBestAnime(wrong, '!!!')).toBeNull();
  });
});
