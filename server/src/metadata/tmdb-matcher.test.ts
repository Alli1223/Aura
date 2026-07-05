import { describe, expect, it } from 'vitest';

import type { TmdbMovieSearchResult, TmdbTvSearchResult } from './tmdb-client.js';
import {
  normaliseTitle,
  pickBestMovie,
  pickBestShow,
  yearFromDateString,
} from './tmdb-matcher.js';

function movie(partial: Partial<TmdbMovieSearchResult> & { id: number; title: string }): TmdbMovieSearchResult {
  return {
    original_title: partial.title,
    release_date: null,
    popularity: 1,
    vote_count: 100,
    vote_average: 7,
    overview: '',
    poster_path: null,
    backdrop_path: null,
    ...partial,
  };
}

function show(partial: Partial<TmdbTvSearchResult> & { id: number; name: string }): TmdbTvSearchResult {
  return {
    original_name: partial.name,
    first_air_date: null,
    popularity: 1,
    vote_count: 100,
    vote_average: 7,
    overview: '',
    poster_path: null,
    backdrop_path: null,
    ...partial,
  };
}

describe('normaliseTitle', () => {
  it('lowercases and strips diacritics', () => {
    expect(normaliseTitle('Amélie')).toBe(normaliseTitle('amelie'));
    expect(normaliseTitle('Léon: The Professional')).toBe('leon professional');
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(normaliseTitle('WALL·E')).toBe('wall e');
    expect(normaliseTitle('  Spider-Man:   No Way Home!! ')).toBe('spider man no way home');
    // Punctuation-separated words normalise identically however they are cut.
    expect(normaliseTitle('M*A*S*H')).toBe(normaliseTitle('M-A-S-H'));
  });

  it('removes leading and sort-form trailing articles', () => {
    expect(normaliseTitle('The Thing')).toBe('thing');
    expect(normaliseTitle('Thing, The')).toBe('thing');
    expect(normaliseTitle('A Beautiful Mind')).toBe('beautiful mind');
    expect(normaliseTitle('An American Werewolf in London')).toBe(
      normaliseTitle('American Werewolf in London'),
    );
  });

  it('keeps article-only titles rather than normalising to ""', () => {
    expect(normaliseTitle('The The')).toBe('the the');
  });
});

describe('yearFromDateString', () => {
  it('extracts the year from TMDB date strings', () => {
    expect(yearFromDateString('2010-07-15')).toBe(2010);
    expect(yearFromDateString('1999')).toBe(1999);
  });

  it('returns undefined for empty/absent/garbage dates', () => {
    expect(yearFromDateString('')).toBeUndefined();
    expect(yearFromDateString(null)).toBeUndefined();
    expect(yearFromDateString(undefined)).toBeUndefined();
    expect(yearFromDateString('soon')).toBeUndefined();
  });
});

describe('pickBestMovie', () => {
  it('prefers exact title + exact year over a far more popular near-miss', () => {
    const remake = movie({
      id: 1,
      title: 'The Thing',
      release_date: '2011-10-12',
      popularity: 900,
    });
    const original = movie({
      id: 2,
      title: 'The Thing',
      release_date: '1982-06-25',
      popularity: 40,
    });

    expect(pickBestMovie([remake, original], 'The Thing', 1982)?.id).toBe(2);
    expect(pickBestMovie([remake, original], 'The Thing', 2011)?.id).toBe(1);
  });

  it('accepts a year within ±1 (regional release offsets)', () => {
    const candidate = movie({ id: 3, title: 'Drive', release_date: '2011-09-15', popularity: 5 });

    expect(pickBestMovie([candidate], 'Drive', 2012)?.id).toBe(3);
    expect(pickBestMovie([candidate], 'Drive', 2010)?.id).toBe(3);
  });

  it('prefers the exact year over a ±1 year when both titles match', () => {
    const early = movie({ id: 4, title: 'Twin Films', release_date: '2011-01-01', popularity: 99 });
    const exact = movie({ id: 5, title: 'Twin Films', release_date: '2012-06-01', popularity: 1 });

    expect(pickBestMovie([early, exact], 'Twin Films', 2012)?.id).toBe(5);
  });

  it('matches diacritic and article variants of the same title', () => {
    const amelie = movie({
      id: 6,
      title: 'Amélie',
      original_title: "Le Fabuleux Destin d'Amélie Poulain",
      release_date: '2001-04-25',
      popularity: 30,
    });
    expect(pickBestMovie([amelie], 'amelie')?.id).toBe(6);

    const thing = movie({ id: 7, title: 'The Thing', release_date: '1982-06-25' });
    expect(pickBestMovie([thing], 'Thing, The', 1982)?.id).toBe(7);
  });

  it('matches on original_title when the display title differs', () => {
    const candidate = movie({
      id: 8,
      title: 'Spirited Away',
      original_title: '千と千尋の神隠し',
      release_date: '2001-07-20',
    });

    expect(pickBestMovie([candidate], '千と千尋の神隠し', 2001)?.id).toBe(8);
  });

  it('breaks title-only ties by popularity', () => {
    const obscure = movie({ id: 9, title: 'Heat', release_date: '1972-01-01', popularity: 2 });
    const famous = movie({ id: 10, title: 'Heat', release_date: '1995-12-15', popularity: 80 });

    // No year known locally: the popular one wins.
    expect(pickBestMovie([obscure, famous], 'Heat')?.id).toBe(10);
  });

  it('returns null when nothing matches the normalised title (no bad guesses)', () => {
    // TMDB search can return fuzzy garbage; a deliberately wrong-titled
    // result set must never produce a match, popularity notwithstanding.
    const wrong = [
      movie({ id: 11, title: 'Iron Man', release_date: '2008-05-02', popularity: 500 }),
      movie({ id: 12, title: 'Iron Man 2', release_date: '2010-05-07', popularity: 400 }),
      movie({ id: 13, title: 'The Iron Giant', release_date: '1999-08-06', popularity: 300 }),
    ];

    expect(pickBestMovie(wrong, 'Iron Chef: The Movie', 2010)).toBeNull();
    expect(pickBestMovie([], 'Anything', 2020)).toBeNull();
    expect(pickBestMovie(wrong, '!!!')).toBeNull();
  });
});

describe('pickBestShow', () => {
  it('prefers exact name + exact first-air year over a popular near-miss', () => {
    const us = show({ id: 20, name: 'The Office', first_air_date: '2005-03-24', popularity: 600 });
    const uk = show({ id: 21, name: 'The Office', first_air_date: '2001-07-09', popularity: 90 });

    expect(pickBestShow([us, uk], 'The Office', 2001)?.id).toBe(21);
  });

  it('accepts a first-air year within ±1 and matches original_name', () => {
    const candidate = show({
      id: 22,
      name: 'Money Heist',
      original_name: 'La casa de papel',
      first_air_date: '2017-05-02',
      popularity: 100,
    });

    expect(pickBestShow([candidate], 'La Casa De Papel', 2018)?.id).toBe(22);
  });

  it('returns null for garbage result sets', () => {
    const wrong = [
      show({ id: 23, name: 'Breaking Bad', first_air_date: '2008-01-20', popularity: 700 }),
    ];

    expect(pickBestShow(wrong, 'Cooking Good', 2008)).toBeNull();
  });
});
