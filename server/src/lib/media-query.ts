import { Prisma, type MediaFile, type MediaItem, type MediaStream } from '@prisma/client';

import { ITEM_NOT_FOUND_MESSAGE } from '../auth/access.js';
import { getPrisma } from '../db/client.js';
import type { MediaItemType } from '../db/constants.js';
import {
  allowedRatingNames,
  hasRating,
  isAllowed,
  KNOWN_RATINGS,
  type RatingFilter,
} from './content-rating.js';
import { notFoundError } from './errors.js';
import {
  type AggregateStateView,
  type ContinueWatchingEntry,
  getStatesForItems,
} from './watch-state.js';

// Read-model / query service backing the browse API (routes/media.ts). It owns
// the serialization of media items, files and streams into the safe, stable
// shapes the web app consumes, and the batched watch-state roll-up so a poster
// grid or a season listing never fans out into an N+1 of per-item queries.
//
// Safety contract for every serialized shape:
// - Never leak a filesystem path or a raw artwork URI (tmdb:/anilist:/local
//   `/media/...`). Artwork is exposed only as the app's artwork route
//   (`/api/items/:id/artwork/:kind`), which the client always goes through.
// - Access control lives entirely in the route layer (assertMediaItemAccess /
//   the library 404 cloak); this module trusts its callers to have gated the
//   ids/libraries it is handed, exactly like lib/watch-state.ts.

/** Top-level browsable item types (a movie or a show, never a season/episode). */
const TOP_LEVEL_TYPES = ['movie', 'show'] as const satisfies readonly MediaItemType[];

/** Prisma include that pulls a media item's genre names in a stable order. */
const GENRES_INCLUDE = {
  genres: { select: { name: true }, orderBy: { name: 'asc' } },
} as const satisfies Prisma.MediaItemInclude;

/** A media item loaded with its genre names (the serializer's input). */
type ItemWithGenres = MediaItem & { genres: { name: string }[] };

/** Watch-state overlay attached to every serialized item. */
export interface ItemWatchState {
  /** Leaf: own flag. Container: true iff it has episodes and all are watched. */
  watched: boolean;
  /** Leaf: resume position. Container: the next-unwatched episode's position. */
  positionMs: number;
  /** Container only (0 for leaves). Total descendant episodes. */
  episodeCount: number;
  /** Container only (0 for leaves). Descendant episodes marked watched. */
  watchedEpisodeCount: number;
  /** Container only (null for leaves). First unwatched episode in play order. */
  nextUnwatchedId: string | null;
}

/** The one safe projection of a media item shared by every browse response. */
export interface SerializedItem {
  id: string;
  libraryId: string;
  type: string;
  title: string;
  sortTitle: string;
  year: number | null;
  overview: string | null;
  tagline: string | null;
  runtimeMs: number | null;
  contentRating: string | null;
  communityRating: number | null;
  genres: string[];
  /** The app's artwork route, or null when the item has no poster. */
  posterUrl: string | null;
  /** The app's artwork route, or null when the item has no backdrop. */
  backdropUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  absoluteEpisodeNumber: number | null;
  addedAt: Date;
  watchState: ItemWatchState;
}

/** A serialized episode carries the extra fields a play button needs. */
export interface SerializedEpisode extends SerializedItem {
  /** Whether the episode has at least one available (playable) file. */
  hasFile: boolean;
  /** The file the play button should stream, or null when none is available. */
  primaryMediaFileId: string | null;
}

/** One audio track of a media file (for the player's audio menu). */
export interface SerializedAudioStream {
  index: number;
  codec: string | null;
  channels: number | null;
  language: string | null;
  title: string | null;
  default: boolean;
}

/** One subtitle track of a media file (for the player's subtitle menu). */
export interface SerializedSubtitleStream {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  forced: boolean;
}

/** A playable file/version of a movie or episode (no filesystem path leaked). */
export interface SerializedFile {
  id: string;
  container: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bitrate: number | null;
  videoCodec: string | null;
  /** Bytes, as a JSON number (BigInt in the DB, well within Number range). */
  size: number;
  audioStreams: SerializedAudioStream[];
  subtitleStreams: SerializedSubtitleStream[];
}

/** Detail payload: the item plus the sub-collection relevant to its type. */
export interface ItemDetail {
  item: SerializedItem;
  /** Movie/episode: its playable files. Containers: empty. */
  files: SerializedFile[];
  /** Show: its seasons with counts. Otherwise empty. */
  seasons: SerializedItem[];
  /** Season: its episodes with play info. Otherwise empty (shows never inline). */
  episodes: SerializedEpisode[];
}

/** Validated inputs for the paginated library listing. */
export interface ListLibraryItemsParams {
  sort: 'title' | 'year' | 'added' | 'rating';
  order: 'asc' | 'desc';
  genre?: string | undefined;
  year?: number | undefined;
  watched: 'true' | 'false' | 'all';
  page: number;
  pageSize: number;
  search?: string | undefined;
}

/** A page of a library's top-level items. */
export interface ListLibraryItemsResult {
  items: SerializedItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** Builds the app's artwork route for a kind, or null when the item has none. */
function artworkUrl(
  item: { id: string; posterPath: string | null; backdropPath: string | null },
  kind: 'poster' | 'backdrop',
): string | null {
  const source = kind === 'poster' ? item.posterPath : item.backdropPath;
  if (source === null || source === '') return null;
  return `/api/items/${item.id}/artwork/${kind}`;
}

function toWatchState(view: AggregateStateView | undefined): ItemWatchState {
  return {
    watched: view?.watched ?? false,
    positionMs: view?.positionMs ?? 0,
    episodeCount: view?.episodeCount ?? 0,
    watchedEpisodeCount: view?.watchedEpisodeCount ?? 0,
    nextUnwatchedId: view?.nextUnwatchedId ?? null,
  };
}

/** Serializes one item to its safe browse shape with a watch-state overlay. */
export function serializeItem(
  item: ItemWithGenres,
  state: AggregateStateView | undefined,
): SerializedItem {
  return {
    id: item.id,
    libraryId: item.libraryId,
    type: item.type,
    title: item.title,
    sortTitle: item.sortTitle,
    year: item.year,
    overview: item.overview,
    tagline: item.tagline,
    runtimeMs: item.runtimeMs,
    contentRating: item.contentRating,
    communityRating: item.communityRating,
    genres: item.genres.map((genre) => genre.name),
    posterUrl: artworkUrl(item, 'poster'),
    backdropUrl: artworkUrl(item, 'backdrop'),
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    absoluteEpisodeNumber: item.absoluteEpisodeNumber,
    addedAt: item.addedAt,
    watchState: toWatchState(state),
  };
}

function serializeFile(file: MediaFile & { streams: MediaStream[] }): SerializedFile {
  const byIndex = (a: MediaStream, b: MediaStream): number => a.streamIndex - b.streamIndex;
  const audioStreams = file.streams
    .filter((stream) => stream.type === 'audio')
    .sort(byIndex)
    .map((stream) => ({
      index: stream.streamIndex,
      codec: stream.codec,
      channels: stream.channels,
      language: stream.language,
      title: stream.title,
      default: stream.isDefault,
    }));
  const subtitleStreams = file.streams
    .filter((stream) => stream.type === 'subtitle')
    .sort(byIndex)
    .map((stream) => ({
      index: stream.streamIndex,
      codec: stream.codec,
      language: stream.language,
      title: stream.title,
      forced: stream.isForced,
    }));
  return {
    id: file.id,
    container: file.container,
    width: file.width,
    height: file.height,
    durationMs: file.durationMs,
    bitrate: file.bitrate,
    videoCodec: file.videoCodec,
    // BigInt -> number: real media sizes are far below Number.MAX_SAFE_INTEGER.
    size: Number(file.size),
    audioStreams,
    subtitleStreams,
  };
}

/** Minimal episode row used for the container watch-state roll-up ordering. */
interface EpisodeOrderRow {
  id: string;
  parentId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  absoluteEpisodeNumber: number | null;
  title: string;
}

/**
 * null sorts first, matching the reference DB ordering in watch-state.ts
 * (`ORDER BY seasonNumber ASC …`, and SQLite sorts NULLs first) so this
 * batched roll-up and getItemState pick the same next-unwatched episode.
 */
function orderValue(value: number | null): number {
  return value ?? Number.NEGATIVE_INFINITY;
}

/** Play-order comparator: season, episode, absolute episode, then title. */
function compareEpisodes(a: EpisodeOrderRow, b: EpisodeOrderRow): number {
  return (
    orderValue(a.seasonNumber) - orderValue(b.seasonNumber) ||
    orderValue(a.episodeNumber) - orderValue(b.episodeNumber) ||
    orderValue(a.absoluteEpisodeNumber) - orderValue(b.absoluteEpisodeNumber) ||
    a.title.localeCompare(b.title)
  );
}

/**
 * Resolves the watch-state overlay for a mixed batch of items in a bounded
 * number of queries (no N+1). Leaves (movie/episode) read their own rows in
 * one lookup; containers (show/season) get the derived roll-up from three
 * batched queries total (their seasons, all descendant episodes, all episode
 * states) regardless of how many containers are in the batch.
 */
export async function resolveItemStates(
  userId: string,
  items: readonly { id: string; type: string }[],
): Promise<Map<string, AggregateStateView>> {
  const result = new Map<string, AggregateStateView>();
  if (items.length === 0) return result;
  const prisma = getPrisma();

  const leafIds: string[] = [];
  const showIds: string[] = [];
  const seasonIds: string[] = [];
  const containerType = new Map<string, MediaItemType>();
  for (const item of items) {
    const type = item.type as MediaItemType;
    if (type === 'movie' || type === 'episode') {
      leafIds.push(item.id);
    } else if (type === 'show') {
      showIds.push(item.id);
      containerType.set(item.id, 'show');
    } else if (type === 'season') {
      seasonIds.push(item.id);
      containerType.set(item.id, 'season');
    }
  }

  if (leafIds.length > 0) {
    const leafStates = await getStatesForItems(userId, leafIds);
    for (const item of items) {
      const type = item.type as MediaItemType;
      if (type !== 'movie' && type !== 'episode') continue;
      const view = leafStates.get(item.id);
      result.set(item.id, {
        mediaItemId: item.id,
        type,
        watched: view?.watched ?? false,
        positionMs: view?.positionMs ?? 0,
        playCount: view?.playCount ?? 0,
        watchedAt: view?.watchedAt ?? null,
        updatedAt: view?.updatedAt ?? null,
        episodeCount: 0,
        watchedEpisodeCount: 0,
        nextUnwatchedId: null,
      });
    }
  }

  const containerIds = [...showIds, ...seasonIds];
  if (containerIds.length === 0) return result;

  // Seasons belonging to the requested shows (to reach their episodes and to
  // route each episode back to its show).
  const showSeasons =
    showIds.length > 0
      ? await prisma.mediaItem.findMany({
          where: { parentId: { in: showIds }, type: 'season' },
          select: { id: true, parentId: true },
        })
      : [];
  const seasonToShow = new Map<string, string>();
  for (const season of showSeasons) {
    if (season.parentId !== null) seasonToShow.set(season.id, season.parentId);
  }

  // Every parent under which a relevant episode may sit: requested seasons,
  // requested shows (season-less episodes) and the shows' seasons.
  const episodeParentIds = [
    ...new Set([...seasonIds, ...showIds, ...showSeasons.map((season) => season.id)]),
  ];
  const episodes =
    episodeParentIds.length > 0
      ? await prisma.mediaItem.findMany({
          where: { parentId: { in: episodeParentIds }, type: 'episode' },
          select: {
            id: true,
            parentId: true,
            seasonNumber: true,
            episodeNumber: true,
            absoluteEpisodeNumber: true,
            title: true,
          },
        })
      : [];

  const episodesByContainer = new Map<string, EpisodeOrderRow[]>();
  for (const id of containerIds) episodesByContainer.set(id, []);
  for (const episode of episodes) {
    const parentId = episode.parentId;
    if (parentId === null) continue;
    // Directly under a requested season or a season-less requested show.
    episodesByContainer.get(parentId)?.push(episode);
    // Under a season of a requested show.
    const showId = seasonToShow.get(parentId);
    if (showId !== undefined) episodesByContainer.get(showId)?.push(episode);
  }

  const episodeStates = await getStatesForItems(
    userId,
    episodes.map((episode) => episode.id),
  );

  for (const containerId of containerIds) {
    const ordered = (episodesByContainer.get(containerId) ?? []).slice().sort(compareEpisodes);
    let watchedEpisodeCount = 0;
    let nextUnwatchedId: string | null = null;
    let resumeMs = 0;
    for (const episode of ordered) {
      const view = episodeStates.get(episode.id);
      if (view?.watched ?? false) {
        watchedEpisodeCount += 1;
      } else if (nextUnwatchedId === null) {
        nextUnwatchedId = episode.id;
        resumeMs = view?.positionMs ?? 0;
      }
    }
    result.set(containerId, {
      mediaItemId: containerId,
      type: containerType.get(containerId) ?? 'show',
      watched: ordered.length > 0 && watchedEpisodeCount === ordered.length,
      positionMs: resumeMs,
      playCount: 0,
      watchedAt: null,
      updatedAt: null,
      episodeCount: ordered.length,
      watchedEpisodeCount,
      nextUnwatchedId,
    });
  }

  return result;
}

/** Serializes a batch of items, resolving their watch-state overlays together. */
async function serializeItems(userId: string, rows: ItemWithGenres[]): Promise<SerializedItem[]> {
  const states = await resolveItemStates(userId, rows);
  return rows.map((row) => serializeItem(row, states.get(row.id)));
}

// ---------------------------------------------------------------------------
// Parental controls — browse/search filtering
// ---------------------------------------------------------------------------
//
// Top-level browse surfaces (library listing, recently-added, search) deal only
// with movies and shows, which carry their OWN contentRating, so a DB-level
// WHERE on the item's rating is both correct and complete — no ancestor walk is
// needed and pagination counts stay consistent (the same predicate feeds count
// and page). Continue-watching is the exception: it lists episodes, whose
// rating lives on the parent show, so it is filtered in memory after resolving
// each entry's effective rating (see filterContinueWatchingByRating).
//
// The DB filter matches stored rating strings exactly (canonical casing, as
// written by the metadata agents). The authoritative, case-insensitive security
// boundary remains assertMediaItemAccess: any stored value that slips past the
// exact-match filter still 404-cloaks on access, so a casing mismatch is at
// worst a cosmetic listing artefact, never a bypass.

/**
 * The `where` fragment that keeps only items a restricted user may see, or an
 * empty fragment when no filter applies (admin / unrestricted). See
 * content-rating.ts for the ladder + the unrated rule.
 */
function buildRatingWhere(filter: RatingFilter | null): Prisma.MediaItemWhereInput {
  if (filter === null) return {};
  const allowed = allowedRatingNames(filter.maxContentRating);
  if (filter.blockUnrated) {
    // Restricted + block unrated: only known, allowed rating names. Null, blank
    // and unknown ratings are all excluded (none is in `allowed`).
    return { contentRating: { in: allowed } };
  }
  // Restricted, unrated permitted: allowed-known names, plus anything the model
  // treats as unrated — a null rating OR a stored value that is not a known
  // rating name. Enumerated positively so SQLite's NULL-vs-NOT-IN semantics
  // never silently drop the null-rated rows.
  return {
    OR: [
      { contentRating: null },
      { contentRating: { in: allowed } },
      { contentRating: { notIn: [...KNOWN_RATINGS] } },
    ],
  };
}

/**
 * Effective content ratings for a batch of items, keyed by id. An item with no
 * own rating inherits its nearest rated ancestor's (episode -> season -> show),
 * resolved level-by-level in a bounded number of queries (no per-item walk).
 * Used by the continue-watching filter, where episodes carry no rating of their
 * own. Items whose own rating is set cost no query.
 */
async function resolveEffectiveRatings(
  items: readonly { id: string; contentRating: string | null; parentId: string | null }[],
): Promise<Map<string, string | null>> {
  const prisma = getPrisma();
  const result = new Map<string, string | null>();
  // itemId -> the ancestor id still to inspect for a rating.
  let pending = new Map<string, string>();
  for (const item of items) {
    if (hasRating(item.contentRating)) result.set(item.id, item.contentRating);
    else if (item.parentId !== null) pending.set(item.id, item.parentId);
    else result.set(item.id, null);
  }

  for (let level = 0; pending.size > 0 && level < 6; level += 1) {
    const ancestorIds = [...new Set(pending.values())];
    const ancestors = await prisma.mediaItem.findMany({
      where: { id: { in: ancestorIds } },
      select: { id: true, contentRating: true, parentId: true },
    });
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    const next = new Map<string, string>();
    for (const [itemId, ancestorId] of pending) {
      const ancestor = byId.get(ancestorId);
      if (ancestor === undefined) result.set(itemId, null);
      else if (hasRating(ancestor.contentRating)) result.set(itemId, ancestor.contentRating);
      else if (ancestor.parentId !== null) next.set(itemId, ancestor.parentId);
      else result.set(itemId, null);
    }
    pending = next;
  }
  // Anything still pending hit the depth guard: treat as unrated.
  for (const itemId of pending.keys()) result.set(itemId, null);
  return result;
}

/**
 * The subset of `items` a restricted user may see, as a Set of ids, applying
 * the same effective-rating rule as item-level enforcement (an unrated
 * season/episode inherits its show's rating). Returns all ids when no filter
 * applies. The shared primitive behind the continue-watching filter and the
 * batch watch-state route, so every leaf-item surface agrees with
 * assertMediaItemAccess.
 */
export async function filterItemIdsByRating(
  items: readonly { id: string; contentRating: string | null; parentId: string | null }[],
  filter: RatingFilter | null,
): Promise<Set<string>> {
  if (filter === null) return new Set(items.map((item) => item.id));
  const effective = await resolveEffectiveRatings(items);
  const allowed = new Set<string>();
  for (const item of items) {
    if (isAllowed(effective.get(item.id) ?? null, filter.maxContentRating, filter.blockUnrated)) {
      allowed.add(item.id);
    }
  }
  return allowed;
}

/**
 * Drops continue-watching entries a restricted user may no longer see (e.g. an
 * episode of a show whose rating now exceeds their cap, or after an admin lowers
 * the cap). Returns the entries unchanged when no filter applies. Runs in the
 * watch route so watch-state.ts stays access-control-free.
 */
export async function filterContinueWatchingByRating(
  entries: readonly ContinueWatchingEntry[],
  filter: RatingFilter | null,
): Promise<ContinueWatchingEntry[]> {
  if (filter === null || entries.length === 0) return [...entries];
  const allowed = await filterItemIdsByRating(
    entries.map((entry) => ({
      id: entry.item.id,
      contentRating: entry.item.contentRating,
      parentId: entry.item.parentId,
    })),
    filter,
  );
  return entries.filter((entry) => allowed.has(entry.item.id));
}

/** Orders a listing at the DB level; ties break on sortTitle then id (stable). */
function buildOrderBy(
  sort: ListLibraryItemsParams['sort'],
  order: 'asc' | 'desc',
): Prisma.MediaItemOrderByWithRelationInput[] {
  switch (sort) {
    case 'title':
      return [{ sortTitle: order }, { id: 'asc' }];
    case 'year':
      return [{ year: order }, { sortTitle: 'asc' }, { id: 'asc' }];
    case 'added':
      return [{ addedAt: order }, { id: 'asc' }];
    case 'rating':
      return [{ communityRating: order }, { sortTitle: 'asc' }, { id: 'asc' }];
  }
}

/** Trims a filter string to a non-empty value, or undefined when blank. */
function cleanFilter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * A page of a library's top-level items (movies for movie-like libraries,
 * shows for tv/anime), sorted/filtered/paginated. When a watched filter is
 * active the derived show state is not stored, so the matching set is loaded,
 * rolled up and filtered in memory before paging; otherwise paging is done at
 * the DB level with a matching count.
 */
export async function listLibraryItems(
  userId: string,
  libraryId: string,
  params: ListLibraryItemsParams,
  ratingFilter: RatingFilter | null,
): Promise<ListLibraryItemsResult> {
  const prisma = getPrisma();
  const genre = cleanFilter(params.genre);
  const search = cleanFilter(params.search);

  const where: Prisma.MediaItemWhereInput = {
    libraryId,
    parentId: null,
    type: { in: [...TOP_LEVEL_TYPES] },
    ...(genre !== undefined ? { genres: { some: { name: genre } } } : {}),
    ...(params.year !== undefined ? { year: params.year } : {}),
    ...(search !== undefined ? { title: { contains: search } } : {}),
    ...buildRatingWhere(ratingFilter),
  };
  const orderBy = buildOrderBy(params.sort, params.order);
  const skip = (params.page - 1) * params.pageSize;

  if (params.watched === 'all') {
    const [total, rows] = await Promise.all([
      prisma.mediaItem.count({ where }),
      prisma.mediaItem.findMany({
        where,
        orderBy,
        skip,
        take: params.pageSize,
        include: GENRES_INCLUDE,
      }),
    ]);
    return {
      items: await serializeItems(userId, rows),
      page: params.page,
      pageSize: params.pageSize,
      total,
    };
  }

  // Watched filter active: roll up state for the whole matching set (still
  // ordered by the DB), filter, then page the filtered slice.
  const rows = await prisma.mediaItem.findMany({ where, orderBy, include: GENRES_INCLUDE });
  const states = await resolveItemStates(userId, rows);
  const wantWatched = params.watched === 'true';
  const filtered = rows.filter((row) => (states.get(row.id)?.watched ?? false) === wantWatched);
  const pageRows = filtered.slice(skip, skip + params.pageSize);
  return {
    items: pageRows.map((row) => serializeItem(row, states.get(row.id))),
    page: params.page,
    pageSize: params.pageSize,
    total: filtered.length,
  };
}

/**
 * How many matching rows the search scan pulls before the in-memory rerank. The
 * DB coarse-orders by rating/recency and caps here; the rerank then floats
 * exact/prefix title matches to the top of that window. Comfortably above the
 * route's max limit (50) so the returned page is drawn from a real candidate set.
 */
const SEARCH_SCAN_CAP = 200;

/**
 * Match tier for the title rerank (lower = better): an exact title, then a
 * title prefix, then a title substring, then a row that only matched on
 * sortTitle or a genre name. Comparison is case-insensitive; `needle` is already
 * lower-cased by the caller.
 */
function titleMatchRank(title: string, needle: string): number {
  const lower = title.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.includes(needle)) return 2;
  return 3;
}

/**
 * Substring/prefix search across the given libraries' top-level items (movies
 * and shows — never seasons/episodes; an episode surfaces via its parent show).
 * Matches title, sortTitle and genre name case-insensitively, then ranks exact
 * title matches above prefixes above other substring matches, breaking ties by
 * communityRating then recency, and caps the result to `limit`.
 *
 * Access is enforced by the caller passing only the user's accessible library
 * ids (as with the home feeds); this service never widens that set, so an item
 * in an ungranted library can never appear — even on an exact title match.
 */
export async function searchLibraryItems(
  userId: string,
  libraryIds: readonly string[],
  rawQuery: string,
  limit: number,
  ratingFilter: RatingFilter | null,
): Promise<SerializedItem[]> {
  const query = rawQuery.trim();
  if (query === '' || libraryIds.length === 0) return [];

  const rows = await getPrisma().mediaItem.findMany({
    where: {
      libraryId: { in: [...libraryIds] },
      parentId: null,
      type: { in: [...TOP_LEVEL_TYPES] },
      // The text match and the rating filter must BOTH hold: nest the match
      // under `AND` so its `OR` never widens past the rating predicate.
      AND: [
        {
          OR: [
            { title: { contains: query } },
            { sortTitle: { contains: query } },
            { genres: { some: { name: { contains: query } } } },
          ],
        },
        buildRatingWhere(ratingFilter),
      ],
    },
    // Coarse order (nulls last for DESC in SQLite): the rerank below keeps this
    // rating/recency order within each match tier via a stable sort.
    orderBy: [{ communityRating: 'desc' }, { addedAt: 'desc' }, { id: 'asc' }],
    take: SEARCH_SCAN_CAP,
    include: GENRES_INCLUDE,
  });

  const needle = query.toLowerCase();
  const ranked = rows
    .map((row, index) => ({ row, index, rank: titleMatchRank(row.title, needle) }))
    // Stable within a tier: the `index` tiebreak preserves the DB rating/recency
    // order even where the engine's sort stability is not guaranteed.
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.row);

  return serializeItems(userId, ranked);
}

/** Most-recently-added top-level items in one library (addedAt desc). */
export async function getLibraryRecentlyAdded(
  userId: string,
  libraryId: string,
  limit: number,
  ratingFilter: RatingFilter | null,
): Promise<SerializedItem[]> {
  const rows = await getPrisma().mediaItem.findMany({
    where: {
      libraryId,
      parentId: null,
      type: { in: [...TOP_LEVEL_TYPES] },
      ...buildRatingWhere(ratingFilter),
    },
    orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    include: GENRES_INCLUDE,
  });
  return serializeItems(userId, rows);
}

/** Most-recently-added top-level items across the given libraries (addedAt desc). */
export async function getHomeRecentlyAdded(
  userId: string,
  libraryIds: readonly string[],
  limit: number,
  ratingFilter: RatingFilter | null,
): Promise<SerializedItem[]> {
  if (libraryIds.length === 0) return [];
  const rows = await getPrisma().mediaItem.findMany({
    where: {
      libraryId: { in: [...libraryIds] },
      parentId: null,
      type: { in: [...TOP_LEVEL_TYPES] },
      ...buildRatingWhere(ratingFilter),
    },
    orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    include: GENRES_INCLUDE,
  });
  return serializeItems(userId, rows);
}

/** The seasons of a show, serialized with their episode counts. */
async function serializeSeasons(userId: string, showId: string): Promise<SerializedItem[]> {
  const seasons = await getPrisma().mediaItem.findMany({
    where: { parentId: showId, type: 'season' },
    orderBy: [{ seasonNumber: 'asc' }, { sortTitle: 'asc' }, { id: 'asc' }],
    include: GENRES_INCLUDE,
  });
  return serializeItems(userId, seasons);
}

/** The episodes of a season, serialized with watch state and play info. */
async function serializeEpisodes(userId: string, seasonId: string): Promise<SerializedEpisode[]> {
  const episodes = await getPrisma().mediaItem.findMany({
    where: { parentId: seasonId, type: 'episode' },
    orderBy: [
      { episodeNumber: 'asc' },
      { absoluteEpisodeNumber: 'asc' },
      { sortTitle: 'asc' },
      { id: 'asc' },
    ],
    include: GENRES_INCLUDE,
  });
  if (episodes.length === 0) return [];

  const states = await resolveItemStates(userId, episodes);
  const files = await getPrisma().mediaFile.findMany({
    where: { mediaItemId: { in: episodes.map((episode) => episode.id) }, status: 'available' },
    select: { id: true, mediaItemId: true },
    orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
  });
  const primaryByItem = new Map<string, string>();
  for (const file of files) {
    if (!primaryByItem.has(file.mediaItemId)) primaryByItem.set(file.mediaItemId, file.id);
  }

  return episodes.map((episode) => ({
    ...serializeItem(episode, states.get(episode.id)),
    hasFile: primaryByItem.has(episode.id),
    primaryMediaFileId: primaryByItem.get(episode.id) ?? null,
  }));
}

/**
 * Full detail for one item. Movie/episode: the item plus its playable files
 * (with per-file audio/subtitle tracks). Show: the item plus its seasons with
 * counts (never inline episodes). Season: the item plus its episodes. The other
 * sub-collections are returned empty so the response shape is uniform.
 */
export async function getItemDetail(userId: string, itemId: string): Promise<ItemDetail> {
  const prisma = getPrisma();
  const full = await prisma.mediaItem.findUnique({
    where: { id: itemId },
    include: GENRES_INCLUDE,
  });
  // The caller resolves access via assertMediaItemAccess before calling, so the
  // row is present; a null here means it was deleted in the race between the
  // access check and this fetch — answer with the same cloaking 404.
  if (full === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);

  const states = await resolveItemStates(userId, [full]);
  const item = serializeItem(full, states.get(full.id));

  if (full.type === 'movie' || full.type === 'episode') {
    // Only available (playable) files: a `missing` file must never be offered
    // as a play/version target — consistent with the episode-listing surface.
    const files = await prisma.mediaFile.findMany({
      where: { mediaItemId: full.id, status: 'available' },
      include: { streams: true },
      orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
    });
    return { item, files: files.map(serializeFile), seasons: [], episodes: [] };
  }
  if (full.type === 'show') {
    return { item, files: [], seasons: await serializeSeasons(userId, full.id), episodes: [] };
  }
  // season
  return { item, files: [], seasons: [], episodes: await serializeEpisodes(userId, full.id) };
}

/**
 * The children of a container: a show's seasons (with counts) or a season's
 * episodes (with watch state + play info). A leaf (movie/episode) has none.
 */
export async function getItemChildren(
  userId: string,
  item: { id: string; type: string },
): Promise<(SerializedItem | SerializedEpisode)[]> {
  if (item.type === 'show') return serializeSeasons(userId, item.id);
  if (item.type === 'season') return serializeEpisodes(userId, item.id);
  return [];
}
