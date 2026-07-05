import type { TmdbMovieSearchResult, TmdbTvSearchResult } from './tmdb-client.js';

// Picks the best TMDB search result for a locally-parsed title/year — or
// nothing. The matcher is deliberately conservative: a result whose
// normalised title does not equal the normalised query is never returned,
// no matter how popular it is. Wrong metadata is worse than no metadata.
//
// Scoring tiers (higher wins; ties broken by TMDB popularity):
//   3  exact normalised title + exact year
//   2  exact normalised title + year within ±1 (regional release offsets)
//   1  exact normalised title (year unknown or mismatched)
//   —  no title match -> null

/**
 * Normalises a title for comparison: lowercase, diacritics stripped (NFKD),
 * punctuation collapsed to spaces, and the articles "the"/"a"/"an" removed
 * wherever they appear as standalone words (handles both "The Thing" and the
 * "Thing, The" sort form). Falls back to the unfiltered words for titles that
 * consist only of articles (e.g. the band "The The").
 */
export function normaliseTitle(raw: string): string {
  const words = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const withoutArticles = words.filter((word) => word !== 'the' && word !== 'a' && word !== 'an');
  return (withoutArticles.length > 0 ? withoutArticles : words).join(' ');
}

/** Extracts the year from a TMDB date string ("2010-07-15"), if present. */
export function yearFromDateString(date: string | null | undefined): number | undefined {
  if (date == null) return undefined;
  const match = /^(\d{4})/.exec(date.trim());
  if (match === null) return undefined;
  return Number.parseInt(match[1] as string, 10);
}

interface CandidateFields {
  /** Title variants to compare (display title, original title, ...). */
  titles: (string | null | undefined)[];
  year: number | undefined;
  popularity: number;
}

function pickBest<T>(
  results: T[],
  fields: (result: T) => CandidateFields,
  title: string,
  year?: number,
): T | null {
  const wanted = normaliseTitle(title);
  if (wanted === '') return null;

  let best: { result: T; tier: number; popularity: number } | null = null;
  for (const result of results) {
    const { titles, year: candidateYear, popularity } = fields(result);
    const titleMatches = titles.some(
      (candidate) => candidate != null && normaliseTitle(candidate) === wanted,
    );
    if (!titleMatches) continue;

    let tier = 1;
    if (year !== undefined && candidateYear !== undefined) {
      if (candidateYear === year) tier = 3;
      else if (Math.abs(candidateYear - year) <= 1) tier = 2;
    }

    if (
      best === null ||
      tier > best.tier ||
      (tier === best.tier && popularity > best.popularity)
    ) {
      best = { result, tier, popularity };
    }
  }
  return best === null ? null : best.result;
}

/**
 * Best movie match for `title` (+ optional `year`) among TMDB search
 * results, or null when no result's normalised title matches.
 */
export function pickBestMovie(
  results: TmdbMovieSearchResult[],
  title: string,
  year?: number,
): TmdbMovieSearchResult | null {
  return pickBest(
    results,
    (result) => ({
      titles: [result.title, result.original_title],
      year: yearFromDateString(result.release_date),
      popularity: result.popularity ?? result.vote_count ?? 0,
    }),
    title,
    year,
  );
}

/**
 * Best TV show match for `title` (+ optional first-air `year`) among TMDB
 * search results, or null when no result's normalised title matches.
 */
export function pickBestShow(
  results: TmdbTvSearchResult[],
  title: string,
  year?: number,
): TmdbTvSearchResult | null {
  return pickBest(
    results,
    (result) => ({
      titles: [result.name, result.original_name],
      year: yearFromDateString(result.first_air_date),
      popularity: result.popularity ?? result.vote_count ?? 0,
    }),
    title,
    year,
  );
}
