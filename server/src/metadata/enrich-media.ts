import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import type { LibraryType } from '../db/constants.js';
import { enrichAnimeItem } from './enrich-anime.js';
import { enrichMovieItem, enrichShowItem } from './enrich-tmdb.js';

// The single metadata entry point the scanner calls per top-level MediaItem.
// It orchestrates the agents and records which source won:
//
//   anime library  ->  AniList first; on no-match/error, fall through to the
//                      TMDB agent for the item's type; if TMDB also produces
//                      nothing, the scanner's filename-derived fields are left
//                      untouched (source 'filename').
//   other library  ->  the TMDB agent directly (movie vs show by item.type).
//
// It never throws for expected conditions — every outcome is a typed result.
// The only 'error' outcome is a genuinely missing MediaItem row.

/** Which agent supplied the metadata (or that none did). */
export type EnrichSource = 'anilist' | 'tmdb' | 'filename' | 'none';

/** Outcome of enriching a MediaItem through the fallback chain. */
export type EnrichMediaResult =
  | { status: 'updated'; source: 'anilist'; mediaItemId: string; anilistId: number }
  | { status: 'updated'; source: 'tmdb'; mediaItemId: string; tmdbId: number }
  | { status: 'filename-fallback'; source: 'filename'; mediaItemId: string }
  | { status: 'error'; source: 'none'; mediaItemId: string; message: string };

/**
 * Runs the TMDB agent appropriate to `type`. Standalone season/episode rows
 * have no TMDB entry point here (the scanner enriches them via the show), so
 * they resolve to 'skipped'.
 */
async function enrichViaTmdb(
  type: string,
  mediaItemId: string,
  log?: FastifyBaseLogger,
): Promise<{ status: 'updated'; tmdbId: number } | { status: 'skipped' }> {
  if (type === 'movie') {
    const result = await enrichMovieItem(mediaItemId, log);
    return result.status === 'updated' ? { status: 'updated', tmdbId: result.tmdbId } : { status: 'skipped' };
  }
  if (type === 'show') {
    const result = await enrichShowItem(mediaItemId, log);
    return result.status === 'updated' ? { status: 'updated', tmdbId: result.tmdbId } : { status: 'skipped' };
  }
  return { status: 'skipped' };
}

/**
 * Enriches a single MediaItem through the fallback chain for its library type.
 * See the module comment for the chain; never throws for expected conditions.
 */
export async function enrichItem(
  mediaItemId: string,
  libraryType: LibraryType,
  log?: FastifyBaseLogger,
): Promise<EnrichMediaResult> {
  const prisma = getPrisma();
  const item = await prisma.mediaItem.findUnique({
    where: { id: mediaItemId },
    select: { type: true },
  });
  if (item === null) {
    return { status: 'error', source: 'none', mediaItemId, message: 'MediaItem not found' };
  }

  if (libraryType === 'anime') {
    const anime = await enrichAnimeItem(mediaItemId, log);
    if (anime.status === 'updated') {
      return { status: 'updated', source: 'anilist', mediaItemId, anilistId: anime.anilistId };
    }
    // no-match or error -> fall through to the TMDB agents below.
  }

  const tmdb = await enrichViaTmdb(item.type, mediaItemId, log);
  if (tmdb.status === 'updated') {
    return { status: 'updated', source: 'tmdb', mediaItemId, tmdbId: tmdb.tmdbId };
  }

  // Neither agent produced metadata: keep the scanner's filename-derived
  // fields (title, year, season/episode numbers) exactly as they are.
  return { status: 'filename-fallback', source: 'filename', mediaItemId };
}
