import { z } from 'zod';

// The content-rating model — the SINGLE SOURCE OF TRUTH for parental controls.
// It is a pure module (no DB, no HTTP): it ranks a rating string, decides
// whether an item is viewable under a user's cap, and lists the rating names a
// DB-level browse filter may keep. The enforcement seam (auth/access.ts) and
// the browse/search filters (lib/media-query.ts) both consume it so the ladder,
// the TV mapping and the "unrated" rule can never drift apart.
//
// Ladder (ASCENDING severity): G(0) < PG(1) < PG-13(2) < R(3) < NC-17(4).
// A user's cap (`maxContentRating`) is always one of these five MPAA names, or
// null for "no personal cap" (unrestricted). An item may carry ANY of the wider
// set of known ratings below (MPAA + US TV), a foreign/unknown certificate, an
// explicit "unrated" marker, or nothing at all — the last three all count as
// "unrated" here (rank === null).
//
// TV → ladder mapping (US TV Parental Guidelines mapped onto the MPAA rungs):
//   TV-Y, TV-Y7, TV-G -> 0 (G)     — all-ages / young-child programming
//   TV-PG             -> 1 (PG)    — parental guidance suggested
//   TV-14             -> 2 (PG-13) — unsuitable under 14
//   TV-MA             -> 3 (R)     — mature audiences
// There is no TV analogue of NC-17. TV-MA maps to R (rank 3), so a user capped
// at R or above may see TV-MA content and a user capped at PG-13 or below may
// not — the intuitive result.

/**
 * The MPAA ladder, ASCENDING (least to most restrictive). This is BOTH the rank
 * order and the exact set of names a user's cap may take. Index === rank.
 */
export const RATING_LADDER = ['G', 'PG', 'PG-13', 'R', 'NC-17'] as const;

/** A cap name: one of the MPAA ladder rungs. */
export type RatingLadderName = (typeof RATING_LADDER)[number];

/**
 * Every rating string this module can rank, mapped to its ladder rank. Keys are
 * canonical UPPERCASE (the casing TMDB writes, which our DB-level filter matches
 * exactly); `rank()` upper-cases its input before lookup so casing never
 * matters at the enforcement seam. Any rating not present here ranks as null
 * ("unrated"): foreign certificates (e.g. "15", "18", "FSK 16"), explicit
 * markers ("NR", "UR", "UNRATED") and empty strings all fall through.
 */
const RANK_BY_RATING: Readonly<Record<string, number>> = {
  // MPAA
  G: 0,
  PG: 1,
  'PG-13': 2,
  R: 3,
  'NC-17': 4,
  // US TV Parental Guidelines
  'TV-Y': 0,
  'TV-Y7': 0,
  'TV-G': 0,
  'TV-PG': 1,
  'TV-14': 2,
  'TV-MA': 3,
};

/**
 * Every rating string the model knows, in canonical casing. Used to build the
 * DB-level browse filter: a stored rating that is NOT one of these is treated
 * as "unrated" (ranks null), exactly as `rank()` treats it.
 */
export const KNOWN_RATINGS: readonly string[] = Object.keys(RANK_BY_RATING);

/** zod schema accepting exactly a ladder cap name (used to validate admin input). */
export const ratingCapSchema = z.enum(RATING_LADDER);

/** Narrows an arbitrary string to a known ladder cap name. */
export function isRatingLadderName(value: string): value is RatingLadderName {
  return (RATING_LADDER as readonly string[]).includes(value);
}

/** Whether a stored value carries an actual rating (non-null, non-blank). */
export function hasRating(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '';
}

/**
 * The ladder rank of a rating: 0 (G) .. 4 (NC-17), with the TV mapping applied.
 * Returns null for a missing, blank or unrecognised rating ("unrated"). Case-
 * and surrounding-whitespace-insensitive.
 */
export function rank(rating: string | null | undefined): number | null {
  if (!hasRating(rating)) return null;
  const key = rating.trim().toUpperCase();
  const value = RANK_BY_RATING[key];
  return value ?? null;
}

/**
 * Whether an item with `itemRating` is viewable by a user whose cap is
 * `userMax`, given the server's `blockUnrated` policy. PURE.
 *
 *  - userMax null (or unrankable) -> unrestricted: always allowed.
 *  - itemRating unrated (rank null) -> allowed UNLESS blockUnrated, in which
 *    case a restricted user is denied.
 *  - otherwise -> allowed iff the item's rank does not exceed the user's cap.
 *
 * An unrankable (corrupt) cap fails OPEN — it cannot be enforced and locking a
 * user out of everything is worse than the (validation-prevented) misconfig.
 */
export function isAllowed(
  itemRating: string | null | undefined,
  userMax: string | null | undefined,
  blockUnrated: boolean,
): boolean {
  if (!hasRating(userMax)) return true;
  const userRank = rank(userMax);
  if (userRank === null) return true;
  const itemRank = rank(itemRating);
  if (itemRank === null) return !blockUnrated;
  return itemRank <= userRank;
}

/**
 * The known rating names (canonical casing) whose rank does not exceed the
 * user's cap — i.e. the values a restricted user is allowed to see. Feeds the
 * DB-level browse filter's `IN` clause. Returns every known name for an
 * unrankable cap (fail open, mirroring `isAllowed`).
 */
export function allowedRatingNames(userMax: string): string[] {
  const userRank = rank(userMax);
  if (userRank === null) return [...KNOWN_RATINGS];
  return KNOWN_RATINGS.filter((name) => {
    const r = rank(name);
    return r !== null && r <= userRank;
  });
}

/**
 * The active parental-controls filter for one request, or null when none
 * applies (an admin or an unrestricted user). Resolved once per request from
 * the user's cap + the server's blockUnrated setting (see auth/access.ts) and
 * threaded into the browse/search query helpers.
 */
export interface RatingFilter {
  /** The restricted user's cap — always a validated ladder name. */
  maxContentRating: string;
  /** Whether unrated/unknown-rated items are hidden from restricted users. */
  blockUnrated: boolean;
}
