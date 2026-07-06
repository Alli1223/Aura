import { describe, expect, it } from 'vitest';

import {
  allowedRatingNames,
  hasRating,
  isAllowed,
  isRatingLadderName,
  KNOWN_RATINGS,
  RATING_LADDER,
  rank,
  ratingCapSchema,
} from './content-rating.js';

// Pure unit tests for the parental-controls rating model: the ladder ordering,
// the TV -> MPAA mapping, rank() for known/unknown/blank ratings, the isAllowed
// matrix (including the null-cap and blockUnrated rules) and the DB-filter
// name list. No database, no HTTP.

describe('rank + ladder ordering', () => {
  it('ranks the MPAA ladder strictly ascending G < PG < PG-13 < R < NC-17', () => {
    const ranks = RATING_LADDER.map((name) => rank(name));
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i]! > ranks[i - 1]!).toBe(true);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(rank('pg-13')).toBe(2);
    expect(rank('  R  ')).toBe(3);
    expect(rank('nc-17')).toBe(4);
    expect(rank('Tv-Ma')).toBe(3);
  });

  it('ranks null, undefined, blank and unknown ratings as null (unrated)', () => {
    expect(rank(null)).toBeNull();
    expect(rank(undefined)).toBeNull();
    expect(rank('')).toBeNull();
    expect(rank('   ')).toBeNull();
    expect(rank('NR')).toBeNull();
    expect(rank('UNRATED')).toBeNull();
    expect(rank('18')).toBeNull(); // a foreign certificate
    expect(rank('FSK 16')).toBeNull();
  });
});

describe('TV -> MPAA mapping', () => {
  it('maps the US TV guidelines onto the documented ladder rungs', () => {
    expect(rank('TV-Y')).toBe(0);
    expect(rank('TV-Y7')).toBe(0);
    expect(rank('TV-G')).toBe(0);
    expect(rank('TV-PG')).toBe(1);
    expect(rank('TV-14')).toBe(2);
    expect(rank('TV-MA')).toBe(3);
  });

  it('places TV-MA at R, so a PG-13 cap blocks it but an R cap allows it', () => {
    expect(isAllowed('TV-MA', 'PG-13', false)).toBe(false);
    expect(isAllowed('TV-MA', 'R', false)).toBe(true);
    expect(isAllowed('TV-14', 'PG-13', false)).toBe(true);
  });
});

describe('isAllowed — cap semantics', () => {
  it('allows everything when the user has no cap (null/undefined/blank)', () => {
    for (const item of ['G', 'NC-17', 'TV-MA', null, 'NR', '18']) {
      expect(isAllowed(item, null, false)).toBe(true);
      expect(isAllowed(item, null, true)).toBe(true);
      expect(isAllowed(item, undefined, false)).toBe(true);
    }
  });

  it('allows an item at or below the cap and blocks one above it', () => {
    // Cap PG-13 (rank 2).
    expect(isAllowed('G', 'PG-13', false)).toBe(true);
    expect(isAllowed('PG', 'PG-13', false)).toBe(true);
    expect(isAllowed('PG-13', 'PG-13', false)).toBe(true);
    expect(isAllowed('R', 'PG-13', false)).toBe(false);
    expect(isAllowed('NC-17', 'PG-13', false)).toBe(false);
  });

  it('covers the full item x cap matrix', () => {
    for (let capRank = 0; capRank < RATING_LADDER.length; capRank += 1) {
      const cap = RATING_LADDER[capRank]!;
      for (let itemRank = 0; itemRank < RATING_LADDER.length; itemRank += 1) {
        const item = RATING_LADDER[itemRank]!;
        expect(isAllowed(item, cap, false)).toBe(itemRank <= capRank);
      }
    }
  });
});

describe('isAllowed — unrated / unknown items', () => {
  it('allows an unrated item to a restricted user by default (blockUnrated false)', () => {
    for (const item of [null, undefined, '', 'NR', 'UNRATED', '18']) {
      expect(isAllowed(item, 'PG-13', false)).toBe(true);
    }
  });

  it('blocks an unrated item for a restricted user when blockUnrated is true', () => {
    for (const item of [null, '', 'NR', '18']) {
      expect(isAllowed(item, 'PG-13', true)).toBe(false);
    }
  });

  it('never blocks unrated items for an uncapped user, even with blockUnrated', () => {
    expect(isAllowed(null, null, true)).toBe(true);
    expect(isAllowed('NR', null, true)).toBe(true);
  });

  it('fails open for an unrankable (corrupt) cap', () => {
    expect(isAllowed('R', 'not-a-rating', false)).toBe(true);
    expect(isAllowed(null, 'not-a-rating', true)).toBe(true);
  });
});

describe('allowedRatingNames — DB filter list', () => {
  it('returns every known name at or below the cap, including TV equivalents', () => {
    const allowed = allowedRatingNames('PG-13');
    expect(allowed).toEqual(expect.arrayContaining(['G', 'PG', 'PG-13', 'TV-G', 'TV-PG', 'TV-14']));
    expect(allowed).not.toContain('R');
    expect(allowed).not.toContain('NC-17');
    expect(allowed).not.toContain('TV-MA');
    // Every returned name genuinely ranks at or below PG-13.
    for (const name of allowed) expect(rank(name)! <= 2).toBe(true);
  });

  it('at G allows only the rank-0 names', () => {
    expect([...allowedRatingNames('G')].sort()).toEqual(['G', 'TV-G', 'TV-Y', 'TV-Y7'].sort());
  });

  it('at NC-17 allows every known rating', () => {
    expect([...allowedRatingNames('NC-17')].sort()).toEqual([...KNOWN_RATINGS].sort());
  });

  it('fails open (all known names) for an unrankable cap', () => {
    expect([...allowedRatingNames('bogus')].sort()).toEqual([...KNOWN_RATINGS].sort());
  });
});

describe('helpers + schema', () => {
  it('hasRating distinguishes real ratings from blank/absent', () => {
    expect(hasRating('R')).toBe(true);
    expect(hasRating(null)).toBe(false);
    expect(hasRating(undefined)).toBe(false);
    expect(hasRating('')).toBe(false);
    expect(hasRating('   ')).toBe(false);
  });

  it('isRatingLadderName accepts only the five MPAA cap names', () => {
    for (const name of RATING_LADDER) expect(isRatingLadderName(name)).toBe(true);
    for (const name of ['TV-MA', 'NR', 'r', 'pg-13', '']) expect(isRatingLadderName(name)).toBe(false);
  });

  it('ratingCapSchema validates ladder names and rejects TV/unknown values', () => {
    for (const name of RATING_LADDER) expect(ratingCapSchema.safeParse(name).success).toBe(true);
    for (const bad of ['TV-MA', 'NR', 'pg-13', '4k', '']) {
      expect(ratingCapSchema.safeParse(bad).success).toBe(false);
    }
  });
});
