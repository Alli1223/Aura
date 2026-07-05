import type { AnilistMedia } from './anilist-client.js';
import { normaliseTitle } from './tmdb-matcher.js';

// Picks the best AniList search result for a locally-parsed title/year — or
// nothing. Mirrors tmdb-matcher's conservative policy: a result whose
// normalised title (romaji, english, native, or any synonym) does not equal
// the normalised query is never returned, no matter how popular it is. Wrong
// metadata is worse than no metadata.
//
// The title normalisation (lowercase, strip diacritics/punctuation, drop
// articles) is reused verbatim from tmdb-matcher so movies, TV and anime all
// match titles the same way.
//
// Scoring tiers (higher wins):
//   3  exact normalised title + exact year
//   2  exact normalised title + year within ±1 (regional release offsets)
//   1  exact normalised title (year unknown or mismatched)
//   —  no title match -> null
// Ties within a tier are broken by averageScore, then by popularity.

/** Re-exported for callers that already have an AniList module imported. */
export { normaliseTitle } from './tmdb-matcher.js';

/** Every title variant AniList offers for a media node. */
export function animeTitles(media: AnilistMedia): (string | null | undefined)[] {
  return [media.title?.romaji, media.title?.english, media.title?.native, ...media.synonyms];
}

/** The best release year for a media node: seasonYear, else startDate.year. */
export function animeYear(media: AnilistMedia): number | undefined {
  return (media.seasonYear ?? media.startDate?.year) ?? undefined;
}

/**
 * Best anime match for `title` (+ optional `year`) among AniList search
 * results, or null when no result's normalised title matches any of the
 * query's title variants.
 */
export function pickBestAnime(
  results: AnilistMedia[],
  title: string,
  year?: number,
): AnilistMedia | null {
  const wanted = normaliseTitle(title);
  if (wanted === '') return null;

  let best: { media: AnilistMedia; tier: number; score: number; popularity: number } | null = null;
  for (const media of results) {
    const titleMatches = animeTitles(media).some(
      (candidate) => candidate != null && normaliseTitle(candidate) === wanted,
    );
    if (!titleMatches) continue;

    const candidateYear = animeYear(media);
    let tier = 1;
    if (year !== undefined && candidateYear !== undefined) {
      if (candidateYear === year) tier = 3;
      else if (Math.abs(candidateYear - year) <= 1) tier = 2;
    }

    const score = media.averageScore ?? 0;
    const popularity = media.popularity ?? 0;
    if (
      best === null ||
      tier > best.tier ||
      (tier === best.tier && score > best.score) ||
      (tier === best.tier && score === best.score && popularity > best.popularity)
    ) {
      best = { media, tier, score, popularity };
    }
  }
  return best === null ? null : best.media;
}
