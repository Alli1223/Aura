import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import { getSetting } from '../lib/settings.js';
import {
  isTmdbClientError,
  TmdbClient,
  TmdbHttpError,
  toTmdbUri,
  type TmdbEpisode,
  type TmdbMovieDetails,
  type TmdbTvDetails,
} from './tmdb-client.js';
import { pickBestMovie, pickBestShow, yearFromDateString } from './tmdb-matcher.js';

// TMDB enrichment for MediaItem rows: search by the item's (filename-parsed)
// title/year, pick the best match conservatively, fetch full details and fill
// in metadata. Design rules:
//
//   - Expected conditions never throw: every enricher returns a typed result
//     with status 'updated' | 'no-match' | 'no-api-key' | 'error'. Only
//     unexpected failures (e.g. database errors) propagate.
//   - Fill-or-replace only: an existing non-null field is never overwritten
//     with null/empty because TMDB had nothing for it. Scanner-owned fields
//     (title, sortTitle, season/episode numbers) are never touched.
//   - posterPath/backdropPath are stored as `tmdb:<imagePath>` URIs (see
//     TMDB_URI_PREFIX in tmdb-client.ts); nothing is downloaded here — the
//     artwork-cache feature resolves and caches these later.
//   - TMDB credits (cast/crew) are fetched and typed on the client but not
//     persisted yet: the schema has no people model. Season/episode rows are
//     only enriched when they already exist — creating hierarchy rows is the
//     scanner's job.

/** Outcome of enriching a single movie or show MediaItem. */
export type EnrichItemResult =
  | { status: 'updated'; mediaItemId: string; tmdbId: number }
  | { status: 'no-match'; mediaItemId: string }
  | { status: 'no-api-key'; mediaItemId: string }
  | { status: 'error'; mediaItemId: string; message: string };

/** A season of the matched show, as reported by TMDB's tv details. */
export interface TmdbSeasonSummary {
  seasonNumber: number;
  name: string | undefined;
  overview: string | undefined;
  episodeCount: number | undefined;
  /** `tmdb:<path>` artwork URI, when TMDB has season art. */
  posterUri: string | undefined;
  airDate: string | undefined;
  year: number | undefined;
}

/** Outcome of enriching a show; includes TMDB's season list on success. */
export type EnrichShowResult =
  | { status: 'updated'; mediaItemId: string; tmdbId: number; seasons: TmdbSeasonSummary[] }
  | { status: 'no-match'; mediaItemId: string }
  | { status: 'no-api-key'; mediaItemId: string }
  | { status: 'error'; mediaItemId: string; message: string };

/** Outcome of enriching a show's existing season/episode rows. */
export type EnrichSeasonsResult =
  | { status: 'updated'; mediaItemId: string; seasonsUpdated: number; episodesUpdated: number }
  | { status: 'no-api-key'; mediaItemId: string }
  | { status: 'error'; mediaItemId: string; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trimmed string when non-empty, otherwise undefined. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
}

/**
 * Reads the configured TMDB API key and builds a client, or returns null
 * when no key is configured (the caller maps this to status 'no-api-key').
 */
async function clientFromSettings(log?: FastifyBaseLogger): Promise<TmdbClient | null> {
  const apiKey = await getSetting('tmdbApiKey', log);
  if (apiKey.trim() === '') return null;
  return new TmdbClient({ apiKey });
}

/**
 * US certification from a movie's release_dates append, falling back to the
 * first non-empty certification from any country.
 */
function movieCertification(details: TmdbMovieDetails): string | undefined {
  const countries = details.release_dates?.results ?? [];
  const ordered = [
    ...countries.filter((country) => country.iso_3166_1 === 'US'),
    ...countries.filter((country) => country.iso_3166_1 !== 'US'),
  ];
  for (const country of ordered) {
    for (const release of country.release_dates) {
      const certification = nonEmpty(release.certification);
      if (certification !== undefined) return certification;
    }
  }
  return undefined;
}

/**
 * US rating from a show's content_ratings append, falling back to the first
 * non-empty rating from any country.
 */
function showCertification(details: TmdbTvDetails): string | undefined {
  const ratings = details.content_ratings?.results ?? [];
  const us = ratings.find((entry) => entry.iso_3166_1 === 'US' && nonEmpty(entry.rating));
  if (us !== undefined) return nonEmpty(us.rating);
  for (const entry of ratings) {
    const rating = nonEmpty(entry.rating);
    if (rating !== undefined) return rating;
  }
  return undefined;
}

/** connectOrCreate input for the Genre m2m; undefined when TMDB has none. */
function genresInput(
  genres: { name: string }[],
): Prisma.MediaItemUpdateInput['genres'] | undefined {
  const names = [...new Set(genres.map((genre) => genre.name.trim()).filter((name) => name !== ''))];
  if (names.length === 0) return undefined;
  return { connectOrCreate: names.map((name) => ({ where: { name }, create: { name } })) };
}

function movieUpdateData(details: TmdbMovieDetails): Prisma.MediaItemUpdateInput {
  const data: Prisma.MediaItemUpdateInput = { tmdbId: details.id };

  const overview = nonEmpty(details.overview);
  if (overview !== undefined) data.overview = overview;
  const tagline = nonEmpty(details.tagline);
  if (tagline !== undefined) data.tagline = tagline;
  const year = yearFromDateString(details.release_date);
  if (year !== undefined) data.year = year;
  if (details.runtime != null && details.runtime > 0) data.runtimeMs = details.runtime * 60_000;
  // TMDB reports vote_average 0 for unrated titles; treat it as "no rating".
  if (details.vote_average != null && details.vote_average > 0) {
    data.communityRating = details.vote_average;
  }
  const certification = movieCertification(details);
  if (certification !== undefined) data.contentRating = certification;
  const imdbId = nonEmpty(details.imdb_id) ?? nonEmpty(details.external_ids?.imdb_id);
  if (imdbId !== undefined) data.imdbId = imdbId;
  const posterPath = nonEmpty(details.poster_path);
  if (posterPath !== undefined) data.posterPath = toTmdbUri(posterPath);
  const backdropPath = nonEmpty(details.backdrop_path);
  if (backdropPath !== undefined) data.backdropPath = toTmdbUri(backdropPath);
  const genres = genresInput(details.genres);
  if (genres !== undefined) data.genres = genres;

  return data;
}

function showUpdateData(details: TmdbTvDetails): Prisma.MediaItemUpdateInput {
  const data: Prisma.MediaItemUpdateInput = { tmdbId: details.id };

  const overview = nonEmpty(details.overview);
  if (overview !== undefined) data.overview = overview;
  const tagline = nonEmpty(details.tagline);
  if (tagline !== undefined) data.tagline = tagline;
  const year = yearFromDateString(details.first_air_date);
  if (year !== undefined) data.year = year;
  // A show has no runtime of its own; store the typical episode runtime.
  const episodeRuntime = details.episode_run_time[0];
  if (episodeRuntime !== undefined && episodeRuntime > 0) {
    data.runtimeMs = episodeRuntime * 60_000;
  }
  if (details.vote_average != null && details.vote_average > 0) {
    data.communityRating = details.vote_average;
  }
  const certification = showCertification(details);
  if (certification !== undefined) data.contentRating = certification;
  const imdbId = nonEmpty(details.external_ids?.imdb_id);
  if (imdbId !== undefined) data.imdbId = imdbId;
  const posterPath = nonEmpty(details.poster_path);
  if (posterPath !== undefined) data.posterPath = toTmdbUri(posterPath);
  const backdropPath = nonEmpty(details.backdrop_path);
  if (backdropPath !== undefined) data.backdropPath = toTmdbUri(backdropPath);
  const genres = genresInput(details.genres);
  if (genres !== undefined) data.genres = genres;

  return data;
}

function episodeUpdateData(episode: TmdbEpisode): Prisma.MediaItemUpdateInput {
  const data: Prisma.MediaItemUpdateInput = {};

  const overview = nonEmpty(episode.overview);
  if (overview !== undefined) data.overview = overview;
  const year = yearFromDateString(episode.air_date);
  if (year !== undefined) data.year = year;
  if (episode.runtime != null && episode.runtime > 0) data.runtimeMs = episode.runtime * 60_000;
  if (episode.vote_average != null && episode.vote_average > 0) {
    data.communityRating = episode.vote_average;
  }
  const stillPath = nonEmpty(episode.still_path);
  if (stillPath !== undefined) data.posterPath = toTmdbUri(stillPath);

  return data;
}

function errorResult(mediaItemId: string, message: string): {
  status: 'error';
  mediaItemId: string;
  message: string;
} {
  return { status: 'error', mediaItemId, message };
}

// ---------------------------------------------------------------------------
// Enrichers
// ---------------------------------------------------------------------------

/**
 * Enriches a movie MediaItem from TMDB using its current title/year.
 * Never throws for expected conditions (missing key, no match, TMDB being
 * down); see EnrichItemResult.
 */
export async function enrichMovieItem(
  mediaItemId: string,
  log?: FastifyBaseLogger,
): Promise<EnrichItemResult> {
  const prisma = getPrisma();
  const item = await prisma.mediaItem.findUnique({ where: { id: mediaItemId } });
  if (item === null) return errorResult(mediaItemId, 'MediaItem not found');
  if (item.type !== 'movie') {
    return errorResult(mediaItemId, `Expected a movie item, got type "${item.type}"`);
  }

  const client = await clientFromSettings(log);
  if (client === null) return { status: 'no-api-key', mediaItemId };

  try {
    const year = item.year ?? undefined;
    const results = await client.searchMovie(item.title, year);
    const match = pickBestMovie(results, item.title, year);
    if (match === null) {
      log?.info({ mediaItemId, title: item.title, year }, 'no TMDB movie match');
      return { status: 'no-match', mediaItemId };
    }

    const details = await client.movieDetails(match.id);
    await prisma.mediaItem.update({ where: { id: mediaItemId }, data: movieUpdateData(details) });
    return { status: 'updated', mediaItemId, tmdbId: details.id };
  } catch (err) {
    if (isTmdbClientError(err)) {
      log?.warn({ mediaItemId, err }, 'TMDB movie enrichment failed');
      return errorResult(mediaItemId, err.message);
    }
    throw err;
  }
}

/**
 * Enriches a show MediaItem from TMDB using its current title/year. On
 * success the result carries TMDB's season list so the scanner can decide
 * which seasons to create/enrich (see enrichSeasonAndEpisodes).
 */
export async function enrichShowItem(
  mediaItemId: string,
  log?: FastifyBaseLogger,
): Promise<EnrichShowResult> {
  const prisma = getPrisma();
  const item = await prisma.mediaItem.findUnique({ where: { id: mediaItemId } });
  if (item === null) return errorResult(mediaItemId, 'MediaItem not found');
  if (item.type !== 'show') {
    return errorResult(mediaItemId, `Expected a show item, got type "${item.type}"`);
  }

  const client = await clientFromSettings(log);
  if (client === null) return { status: 'no-api-key', mediaItemId };

  try {
    const year = item.year ?? undefined;
    const results = await client.searchTv(item.title, year);
    const match = pickBestShow(results, item.title, year);
    if (match === null) {
      log?.info({ mediaItemId, title: item.title, year }, 'no TMDB show match');
      return { status: 'no-match', mediaItemId };
    }

    const details = await client.tvDetails(match.id);
    await prisma.mediaItem.update({ where: { id: mediaItemId }, data: showUpdateData(details) });

    const seasons: TmdbSeasonSummary[] = details.seasons.map((season) => {
      const posterPath = nonEmpty(season.poster_path);
      return {
        seasonNumber: season.season_number,
        name: nonEmpty(season.name),
        overview: nonEmpty(season.overview),
        episodeCount: season.episode_count ?? undefined,
        posterUri: posterPath === undefined ? undefined : toTmdbUri(posterPath),
        airDate: nonEmpty(season.air_date),
        year: yearFromDateString(season.air_date),
      };
    });
    return { status: 'updated', mediaItemId, tmdbId: details.id, seasons };
  } catch (err) {
    if (isTmdbClientError(err)) {
      log?.warn({ mediaItemId, err }, 'TMDB show enrichment failed');
      return errorResult(mediaItemId, err.message);
    }
    throw err;
  }
}

/**
 * Enriches a show's EXISTING season and episode MediaItem rows from TMDB
 * season details (`tvId` is the show's TMDB id, e.g. from enrichShowItem's
 * result or MediaItem.tmdbId). Rows are matched by season/episode number;
 * rows without a number, and TMDB seasons/episodes with no local row, are
 * skipped — creating hierarchy rows is the scanner's job. Seasons TMDB does
 * not know (404) are skipped rather than failing the whole run.
 */
export async function enrichSeasonAndEpisodes(
  showItemId: string,
  tvId: number,
  log?: FastifyBaseLogger,
): Promise<EnrichSeasonsResult> {
  const prisma = getPrisma();
  const show = await prisma.mediaItem.findUnique({ where: { id: showItemId } });
  if (show === null) return errorResult(showItemId, 'MediaItem not found');
  if (show.type !== 'show') {
    return errorResult(showItemId, `Expected a show item, got type "${show.type}"`);
  }

  const client = await clientFromSettings(log);
  if (client === null) return { status: 'no-api-key', mediaItemId: showItemId };

  const seasons = await prisma.mediaItem.findMany({
    where: { parentId: showItemId, type: 'season' },
    orderBy: { seasonNumber: 'asc' },
  });

  let seasonsUpdated = 0;
  let episodesUpdated = 0;
  try {
    for (const season of seasons) {
      if (season.seasonNumber === null) continue;

      let details;
      try {
        details = await client.seasonDetails(tvId, season.seasonNumber);
      } catch (err) {
        if (err instanceof TmdbHttpError && err.status === 404) {
          log?.info(
            { showItemId, tvId, seasonNumber: season.seasonNumber },
            'season not found on TMDB; skipping',
          );
          continue;
        }
        throw err;
      }

      const seasonData: Prisma.MediaItemUpdateInput = {};
      const overview = nonEmpty(details.overview);
      if (overview !== undefined) seasonData.overview = overview;
      const year = yearFromDateString(details.air_date);
      if (year !== undefined) seasonData.year = year;
      const posterPath = nonEmpty(details.poster_path);
      if (posterPath !== undefined) seasonData.posterPath = toTmdbUri(posterPath);
      if (Object.keys(seasonData).length > 0) {
        await prisma.mediaItem.update({ where: { id: season.id }, data: seasonData });
      }
      seasonsUpdated += 1;

      const episodes = await prisma.mediaItem.findMany({
        where: { parentId: season.id, type: 'episode' },
      });
      const byNumber = new Map(details.episodes.map((episode) => [episode.episode_number, episode]));
      for (const episode of episodes) {
        const remote = episode.episodeNumber === null ? undefined : byNumber.get(episode.episodeNumber);
        if (remote === undefined) continue;
        const episodeData = episodeUpdateData(remote);
        if (Object.keys(episodeData).length === 0) continue;
        await prisma.mediaItem.update({ where: { id: episode.id }, data: episodeData });
        episodesUpdated += 1;
      }
    }
    return { status: 'updated', mediaItemId: showItemId, seasonsUpdated, episodesUpdated };
  } catch (err) {
    if (isTmdbClientError(err)) {
      log?.warn({ showItemId, tvId, err }, 'TMDB season/episode enrichment failed');
      return errorResult(showItemId, err.message);
    }
    throw err;
  }
}
