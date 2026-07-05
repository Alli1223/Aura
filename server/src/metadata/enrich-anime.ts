import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import {
  AnilistClient,
  isAnilistClientError,
  toAnilistUri,
  type AnilistMedia,
} from './anilist-client.js';
import { animeYear, pickBestAnime } from './anilist-matcher.js';

// AniList enrichment for MediaItem rows in anime libraries: search by the
// item's (filename-parsed) title/year, pick the best match conservatively and
// fill in metadata. Design rules mirror the TMDB enricher (enrich-tmdb.ts):
//
//   - Expected conditions never throw: enrichAnimeItem returns a typed result
//     with status 'updated' | 'no-match' | 'error' (all tagged source
//     'anilist'). Only unexpected failures (e.g. database errors) propagate.
//   - Fill-or-replace only: an existing non-empty field is never overwritten
//     with an empty/absent AniList value. Scanner-owned fields (title,
//     sortTitle, season/episode numbers) are never touched.
//   - posterPath/backdropPath are stored as `anilist:<url>` URIs (see
//     ANILIST_URI_PREFIX in anilist-client.ts); nothing is downloaded here.
//     NOTE: artwork-cache only fetches image.tmdb.org today, so these will not
//     render until it is extended to allow the AniList CDN host (s4.anilist.co)
//     — tracked as its own TODO.md item.
//
// AniList models a *series* (Media), not individual episodes, so this enricher
// searches by the item's title regardless of its type. `averageScore` is a
// 0-100 percentage and is converted to the 0-10 communityRating scale (the
// same scale TMDB's vote_average uses) by dividing by 10. `duration` is
// minutes per episode (the whole runtime for a film).

/** Outcome of enriching a single MediaItem from AniList. */
export type EnrichAnimeResult =
  | { status: 'updated'; source: 'anilist'; mediaItemId: string; anilistId: number }
  | { status: 'no-match'; source: 'anilist'; mediaItemId: string }
  | { status: 'error'; source: 'anilist'; mediaItemId: string; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trimmed string when non-empty, otherwise undefined. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
}

/** connectOrCreate input for the Genre m2m; undefined when AniList has none. */
function genresInput(genres: string[]): Prisma.MediaItemUpdateInput['genres'] | undefined {
  const names = [...new Set(genres.map((genre) => genre.trim()).filter((name) => name !== ''))];
  if (names.length === 0) return undefined;
  return { connectOrCreate: names.map((name) => ({ where: { name }, create: { name } })) };
}

function animeUpdateData(media: AnilistMedia): Prisma.MediaItemUpdateInput {
  const data: Prisma.MediaItemUpdateInput = { anilistId: media.id };

  const overview = nonEmpty(media.description);
  if (overview !== undefined) data.overview = overview;
  const year = animeYear(media);
  if (year !== undefined) data.year = year;
  // AniList averageScore is a 0-100 percentage; communityRating is a 0-10
  // scale (matching TMDB's vote_average), so divide by 10. A 0/absent score
  // means "unrated" and must not overwrite an existing rating.
  if (media.averageScore != null && media.averageScore > 0) {
    data.communityRating = media.averageScore / 10;
  }
  // `duration` is minutes per episode (the full runtime for a film).
  if (media.duration != null && media.duration > 0) data.runtimeMs = media.duration * 60_000;
  const poster = nonEmpty(media.coverImage?.extraLarge) ?? nonEmpty(media.coverImage?.large);
  if (poster !== undefined) data.posterPath = toAnilistUri(poster);
  const banner = nonEmpty(media.bannerImage);
  if (banner !== undefined) data.backdropPath = toAnilistUri(banner);
  const genres = genresInput(media.genres);
  if (genres !== undefined) data.genres = genres;

  return data;
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

/**
 * Enriches a MediaItem from AniList using its current title/year. Never throws
 * for expected conditions (no match, AniList being down / rate-limited); see
 * EnrichAnimeResult.
 */
export async function enrichAnimeItem(
  mediaItemId: string,
  log?: FastifyBaseLogger,
): Promise<EnrichAnimeResult> {
  const prisma = getPrisma();
  const item = await prisma.mediaItem.findUnique({ where: { id: mediaItemId } });
  if (item === null) {
    return { status: 'error', source: 'anilist', mediaItemId, message: 'MediaItem not found' };
  }

  const client = new AnilistClient();
  try {
    const year = item.year ?? undefined;
    const results = await client.searchAnime(item.title);
    const match = pickBestAnime(results, item.title, year);
    if (match === null) {
      log?.info({ mediaItemId, title: item.title, year }, 'no AniList match');
      return { status: 'no-match', source: 'anilist', mediaItemId };
    }

    await prisma.mediaItem.update({ where: { id: mediaItemId }, data: animeUpdateData(match) });
    return { status: 'updated', source: 'anilist', mediaItemId, anilistId: match.id };
  } catch (err) {
    if (isAnilistClientError(err)) {
      log?.warn({ mediaItemId, err }, 'AniList enrichment failed');
      return { status: 'error', source: 'anilist', mediaItemId, message: err.message };
    }
    throw err;
  }
}
