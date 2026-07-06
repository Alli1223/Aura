import { Prisma } from '@prisma/client';

import { getPrisma } from '../db/client.js';
import type { RatingFilter } from './content-rating.js';
import { filterItemIdsByRating, serializeItem, type SerializedItem } from './media-query.js';
import type { AggregateStateView } from './watch-state.js';

// Per-user watch history read model.
//
// The schema has no append-only event log — WatchState carries only the CURRENT
// per-item progress/watched/playCount (updatedAt/watchedAt). "History" is
// therefore derived from the WatchState rows the user has actually interacted
// with (positionMs > 0 OR watched OR playCount > 0), ordered by most-recent
// activity (the row's updatedAt). A true event log (one row per play/seek)
// remains a possible future enhancement; until then this is the pragmatic,
// schema-faithful view.
//
// Access control lives in the route layer (the caller passes only the user's
// accessible library ids and the parental-controls filter), exactly like the
// browse feeds — this module never widens the set it is handed.

/** Only playable leaves ever carry a WatchState row; history lists those. */
const HISTORY_TYPES = ['movie', 'episode'] as const;

/** Genre include so the shared serializer can render the item's genres. */
const HISTORY_INCLUDE = {
  genres: { select: { name: true }, orderBy: { name: 'asc' } },
  // An episode's show title lives two levels up (episode -> season -> show); a
  // season-less layout puts the episode directly under the show. Pull both hops
  // so the show context can be resolved without extra queries.
  parent: { select: { id: true, type: true, title: true, parentId: true } },
} as const satisfies Prisma.MediaItemInclude;

/** The per-row watch state a history entry carries (its own leaf row). */
export interface HistoryWatchState {
  positionMs: number;
  watched: boolean;
  watchedAt: Date | null;
  playCount: number;
  /** The row's last-touched time — the recency key the list is ordered by. */
  lastActivity: Date;
}

/** One history row: the serialized item, its watch state and show context. */
export interface HistoryEntry {
  item: SerializedItem;
  watchState: HistoryWatchState;
  /** Episode only (null for movies): its show's id + title for context. */
  showId: string | null;
  showTitle: string | null;
}

/** A page of the caller's watch history. */
export interface HistoryPage {
  items: HistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
}

/** Builds the AggregateStateView a serialized leaf carries from its own row. */
function toLeafView(row: {
  mediaItemId: string;
  type: string;
  positionMs: number;
  watched: boolean;
  watchedAt: Date | null;
  playCount: number;
  updatedAt: Date;
}): AggregateStateView {
  return {
    mediaItemId: row.mediaItemId,
    type: row.type as AggregateStateView['type'],
    watched: row.watched,
    positionMs: row.positionMs,
    playCount: row.playCount,
    watchedAt: row.watchedAt,
    updatedAt: row.updatedAt,
    episodeCount: 0,
    watchedEpisodeCount: 0,
    nextUnwatchedId: null,
  };
}

/** Resolves an episode's owning show (id + title) from its parent chain. */
function resolveShow(
  parent: {
    id: string;
    type: string;
    title: string;
    parentId: string | null;
  } | null,
): { showId: string | null; showTitle: string | null } {
  if (parent === null) return { showId: null, showTitle: null };
  // Season-less layout: the episode sits directly under the show.
  if (parent.type === 'show') return { showId: parent.id, showTitle: parent.title };
  // Normal layout: episode -> season -> show. The season row was loaded with a
  // shallow parent select, so it exposes only the show's id, not its title;
  // the title is filled in below from a single batched lookup.
  if (parent.type === 'season') return { showId: parent.parentId, showTitle: null };
  return { showId: null, showTitle: null };
}

/**
 * The caller's watch history: WatchState rows they have interacted with
 * (positionMs > 0, watched, or playCount > 0) for movies/episodes in accessible
 * libraries, most-recently-active first, filtered by the parental-controls cap
 * (an episode inherits its show's rating) then paginated.
 *
 * Rating filtering runs in memory (episodes carry no own rating, so the DB
 * predicate can't express the inherited cap — same reason continue-watching
 * filters in memory), so the whole matching set is loaded, filtered, then the
 * requested page is sliced. A single user's interacted-item count is bounded by
 * the libraries they can see, so this stays cheap.
 */
export async function getUserHistory(
  userId: string,
  libraryIds: readonly string[],
  page: number,
  pageSize: number,
  ratingFilter: RatingFilter | null,
): Promise<HistoryPage> {
  if (libraryIds.length === 0) {
    return { items: [], page, pageSize, total: 0 };
  }
  const prisma = getPrisma();

  const rows = await prisma.watchState.findMany({
    where: {
      userId,
      OR: [{ watched: true }, { positionMs: { gt: 0 } }, { playCount: { gt: 0 } }],
      mediaItem: { libraryId: { in: [...libraryIds] }, type: { in: [...HISTORY_TYPES] } },
    },
    orderBy: [{ updatedAt: 'desc' }, { mediaItemId: 'asc' }],
    include: { mediaItem: { include: HISTORY_INCLUDE } },
  });

  // Parental controls: keep only rows whose (effective) rating is within cap.
  const allowedIds = await filterItemIdsByRating(
    rows.map((row) => ({
      id: row.mediaItemId,
      contentRating: row.mediaItem.contentRating,
      parentId: row.mediaItem.parentId,
    })),
    ratingFilter,
  );
  const visible = rows.filter((row) => allowedIds.has(row.mediaItemId));

  const total = visible.length;
  const skip = (page - 1) * pageSize;
  const pageRows = visible.slice(skip, skip + pageSize);

  // Fill in missing show titles (episodes under a season expose only the show
  // id in their shallow parent select) with one batched lookup.
  const shows = pageRows.map((row) => resolveShow(row.mediaItem.parent));
  const missingShowIds = [
    ...new Set(
      shows
        .filter((show) => show.showId !== null && show.showTitle === null)
        .map((show) => show.showId as string),
    ),
  ];
  const showTitles = new Map<string, string>();
  if (missingShowIds.length > 0) {
    const showRows = await prisma.mediaItem.findMany({
      where: { id: { in: missingShowIds } },
      select: { id: true, title: true },
    });
    for (const show of showRows) showTitles.set(show.id, show.title);
  }

  const items: HistoryEntry[] = pageRows.map((row, index) => {
    const { mediaItem } = row;
    const view = toLeafView({ ...row, type: mediaItem.type });
    const show = shows[index] ?? { showId: null, showTitle: null };
    const showTitle =
      show.showTitle ?? (show.showId !== null ? (showTitles.get(show.showId) ?? null) : null);
    return {
      // serializeItem reads only the item's scalar fields + genres; the extra
      // `parent` relation on this row is ignored.
      item: serializeItem(mediaItem, view),
      watchState: {
        positionMs: row.positionMs,
        watched: row.watched,
        watchedAt: row.watchedAt,
        playCount: row.playCount,
        lastActivity: row.updatedAt,
      },
      showId: show.showId,
      showTitle,
    };
  });

  return { items, page, pageSize, total };
}
