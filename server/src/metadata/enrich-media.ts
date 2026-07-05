import path from 'node:path';

import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import type { LibraryType } from '../db/constants.js';
import { mediaRootsFromEnv } from '../lib/media-roots.js';
import { toSortTitle } from '../scanner/scan.js';
import { enrichAnimeItem } from './enrich-anime.js';
import { enrichMovieItem, enrichShowItem } from './enrich-tmdb.js';
import { readLocalMetadata, type LocalItemType, type LocalMetadata } from './local-metadata.js';

// The single metadata entry point the scanner calls per top-level MediaItem.
// It orchestrates the agents, applies local sidecar overrides and records
// which source won:
//
//   anime library  ->  AniList first; on no-match/error, fall through to the
//                      TMDB agent for the item's type; if TMDB also produces
//                      nothing, the scanner's filename-derived fields are left
//                      untouched (source 'filename').
//   other library  ->  the TMDB agent directly (movie vs show by item.type).
//
// AFTER the online agents run, local metadata (a Kodi .nfo sidecar and/or
// local artwork next to the media) is read and OVERLAID on top: local always
// outranks online, so any field an .nfo provides wins even over a fresh online
// fetch, and a local poster/fanart replaces the online artwork path. Online is
// still consulted first so its genres/artwork/ids fill the gaps the .nfo does
// not cover. When local data is applied the source is reported as 'local',
// 'local+tmdb' or 'local+anilist' accordingly. With no local files the
// behaviour (and the reported source) is identical to online-only enrichment.
//
// It never throws for expected conditions — every outcome is a typed result.
// The only 'error' outcome is a genuinely missing MediaItem row.

/** Which source(s) supplied the metadata (or that none did). */
export type EnrichSource =
  | 'anilist'
  | 'tmdb'
  | 'filename'
  | 'none'
  | 'local'
  | 'local+anilist'
  | 'local+tmdb';

/** Outcome of enriching a MediaItem through the fallback chain + local overlay. */
export type EnrichMediaResult =
  | { status: 'updated'; source: 'anilist'; mediaItemId: string; anilistId: number }
  | { status: 'updated'; source: 'tmdb'; mediaItemId: string; tmdbId: number }
  | { status: 'updated'; source: 'local'; mediaItemId: string }
  | { status: 'updated'; source: 'local+anilist'; mediaItemId: string; anilistId: number }
  | { status: 'updated'; source: 'local+tmdb'; mediaItemId: string; tmdbId: number }
  | { status: 'filename-fallback'; source: 'filename'; mediaItemId: string }
  | { status: 'error'; source: 'none'; mediaItemId: string; message: string };

/** The online agents' verdict, before the local overlay composes the source. */
type OnlineOutcome =
  | { kind: 'anilist'; anilistId: number }
  | { kind: 'tmdb'; tmdbId: number }
  | { kind: 'none' };

/**
 * Runs the TMDB agent appropriate to `type`. Standalone season/episode rows
 * have no TMDB entry point here (the scanner enriches them via the show), so
 * they resolve to 'none'.
 */
async function enrichViaTmdb(
  type: string,
  mediaItemId: string,
  log?: FastifyBaseLogger,
): Promise<OnlineOutcome> {
  if (type === 'movie') {
    const result = await enrichMovieItem(mediaItemId, log);
    return result.status === 'updated' ? { kind: 'tmdb', tmdbId: result.tmdbId } : { kind: 'none' };
  }
  if (type === 'show') {
    const result = await enrichShowItem(mediaItemId, log);
    return result.status === 'updated' ? { kind: 'tmdb', tmdbId: result.tmdbId } : { kind: 'none' };
  }
  return { kind: 'none' };
}

/**
 * Enriches a single MediaItem: online agents first, then a local sidecar
 * overlay that outranks them. See the module comment for the chain; never
 * throws for expected conditions. `mediaRoots` bounds every filesystem lookup
 * (defaults to the MEDIA_ROOTS environment variable).
 */
export async function enrichItem(
  mediaItemId: string,
  libraryType: LibraryType,
  log?: FastifyBaseLogger,
  mediaRoots: readonly string[] = mediaRootsFromEnv(),
): Promise<EnrichMediaResult> {
  const prisma = getPrisma();
  const item = await prisma.mediaItem.findUnique({
    where: { id: mediaItemId },
    select: { id: true, type: true, libraryId: true },
  });
  if (item === null) {
    return { status: 'error', source: 'none', mediaItemId, message: 'MediaItem not found' };
  }

  // 1. Online enrichment (unchanged behaviour).
  let online: OnlineOutcome = { kind: 'none' };
  if (libraryType === 'anime') {
    const anime = await enrichAnimeItem(mediaItemId, log);
    online =
      anime.status === 'updated'
        ? { kind: 'anilist', anilistId: anime.anilistId }
        : await enrichViaTmdb(item.type, mediaItemId, log);
  } else {
    online = await enrichViaTmdb(item.type, mediaItemId, log);
  }

  // 2. Local sidecar overlay (outranks online). Applied last so NFO fields and
  //    local artwork win over whatever the agents wrote.
  const local = await loadLocalMetadata(prisma, item, mediaRoots, log);
  const localUpdate = buildLocalUpdate(local);
  const localApplied = Object.keys(localUpdate).length > 0;
  if (localApplied) {
    await prisma.mediaItem.update({ where: { id: mediaItemId }, data: localUpdate });
  }

  // 3. Compose the result: local presence promotes the source.
  if (localApplied) {
    if (online.kind === 'anilist') {
      return { status: 'updated', source: 'local+anilist', mediaItemId, anilistId: online.anilistId };
    }
    if (online.kind === 'tmdb') {
      return { status: 'updated', source: 'local+tmdb', mediaItemId, tmdbId: online.tmdbId };
    }
    return { status: 'updated', source: 'local', mediaItemId };
  }
  if (online.kind === 'anilist') {
    return { status: 'updated', source: 'anilist', mediaItemId, anilistId: online.anilistId };
  }
  if (online.kind === 'tmdb') {
    return { status: 'updated', source: 'tmdb', mediaItemId, tmdbId: online.tmdbId };
  }
  return { status: 'filename-fallback', source: 'filename', mediaItemId };
}

// ---------------------------------------------------------------------------
// Local overlay plumbing
// ---------------------------------------------------------------------------

interface ItemForLocal {
  id: string;
  type: string;
  libraryId: string;
}

/**
 * Reads the local sidecars for an item. Movies/episodes are keyed off their
 * own video file; shows off their folder, derived from a descendant episode's
 * path relative to a configured library root. Seasons have no local sidecar
 * handling. Always path-safe and never throws.
 */
async function loadLocalMetadata(
  prisma: ReturnType<typeof getPrisma>,
  item: ItemForLocal,
  mediaRoots: readonly string[],
  log?: FastifyBaseLogger,
): Promise<LocalMetadata> {
  try {
    if (item.type === 'movie' || item.type === 'episode') {
      const file = await prisma.mediaFile.findFirst({
        where: { mediaItemId: item.id },
        select: { path: true },
        orderBy: [{ status: 'asc' }, { path: 'asc' }],
      });
      if (file === null) return { nfo: null };
      return await readLocalMetadata({
        videoPath: file.path,
        itemType: item.type as LocalItemType,
        mediaRoots,
      });
    }

    if (item.type === 'show') {
      const showDir = await deriveShowDir(prisma, item);
      if (showDir === undefined) return { nfo: null };
      return await readLocalMetadata({ showDir, itemType: 'show', mediaRoots });
    }
  } catch (err) {
    // Local metadata is best-effort; a filesystem hiccup must never fail
    // enrichment.
    log?.warn({ mediaItemId: item.id, err }, 'local metadata read failed');
  }
  return { nfo: null };
}

/**
 * Derives a show's folder from a descendant episode file: the show folder is
 * the immediate child of a configured library root on the path to the episode
 * (the standard `<root>/<Show>/<Season>/<episode>` layout, and the flat
 * `<root>/<Show>/<episode>` anime layout). Undefined when the show has no
 * files yet or none sit under a known root.
 */
async function deriveShowDir(
  prisma: ReturnType<typeof getPrisma>,
  item: ItemForLocal,
): Promise<string | undefined> {
  const episodeFile = await prisma.mediaFile.findFirst({
    where: { mediaItem: { type: 'episode', parent: { parentId: item.id } } },
    select: { path: true },
    orderBy: { path: 'asc' },
  });
  if (episodeFile === null) return undefined;

  const library = await prisma.library.findUnique({
    where: { id: item.libraryId },
    select: { paths: { select: { path: true } } },
  });
  for (const root of library?.paths ?? []) {
    const relative = path.relative(root.path, episodeFile.path);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const first = relative.split(path.sep)[0];
    if (first === undefined || first === '' || first === '.' || first === '..') continue;
    return path.join(root.path, first);
  }
  return undefined;
}

/**
 * Builds the Prisma update that overlays local metadata on top of whatever the
 * online agents wrote. NFO scalar fields overwrite unconditionally (local
 * wins); NFO genres are added; local artwork replaces the poster/backdrop
 * paths. Returns an empty object when there is nothing local to apply.
 */
function buildLocalUpdate(local: LocalMetadata): Prisma.MediaItemUpdateInput {
  const data: Prisma.MediaItemUpdateInput = {};
  const nfo = local.nfo;

  if (nfo !== null) {
    if (nfo.title !== undefined) {
      data.title = nfo.title;
      data.sortTitle = toSortTitle(nfo.title);
    }
    if (nfo.year !== undefined) data.year = nfo.year;
    if (nfo.overview !== undefined) data.overview = nfo.overview;
    if (nfo.tagline !== undefined) data.tagline = nfo.tagline;
    if (nfo.runtimeMs !== undefined) data.runtimeMs = nfo.runtimeMs;
    if (nfo.communityRating !== undefined) data.communityRating = nfo.communityRating;
    if (nfo.contentRating !== undefined) data.contentRating = nfo.contentRating;
    if (nfo.tmdbId !== undefined) data.tmdbId = nfo.tmdbId;
    if (nfo.imdbId !== undefined) data.imdbId = nfo.imdbId;
    if (nfo.genres.length > 0) {
      data.genres = {
        connectOrCreate: nfo.genres.map((name) => ({ where: { name }, create: { name } })),
      };
    }
  }

  if (local.posterPath !== undefined) data.posterPath = local.posterPath;
  if (local.backdropPath !== undefined) data.backdropPath = local.backdropPath;

  return data;
}
