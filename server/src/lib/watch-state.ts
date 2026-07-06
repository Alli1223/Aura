import type { WatchState } from '@prisma/client';

import { getPrisma } from '../db/client.js';
import type { MediaItemType } from '../db/constants.js';

// Per-user playback progress, resume positions and watched/unwatched state.
//
// This service owns every write to the WatchState model (composite unique
// userId+mediaItemId). It knows nothing about HTTP or access control — routes
// gate every call through assertMediaItemAccess / getAccessibleLibraryIds
// first, so the enumeration cloak and disabled-user rejection live in exactly
// one place (the auth layer) and are never duplicated here.
//
// Derived state for containers: a show/season has no WatchState row of its
// own. Its "watched" is derived (all descendant episodes watched) and its
// resume / On-Deck position is the first unwatched episode. Marking a
// container watched cascades to every descendant episode.

/** Fraction of a known duration past which playback auto-marks as watched. */
export const WATCHED_THRESHOLD = 0.9;

/** Public projection of a single WatchState row (a movie or episode). */
export interface WatchStateView {
  mediaItemId: string;
  positionMs: number;
  watched: boolean;
  watchedAt: Date | null;
  playCount: number;
  updatedAt: Date | null;
}

/**
 * Unified state for one item as seen by the detail page. Leaves (movie,
 * episode) carry their own row's values; containers (show, season) carry
 * derived aggregates and the container-only fields describe the roll-up.
 */
export interface AggregateStateView {
  mediaItemId: string;
  type: MediaItemType;
  /** Leaf: own flag. Container: true iff it has episodes and all are watched. */
  watched: boolean;
  /** Leaf: own resume position. Container: the next-unwatched episode's position. */
  positionMs: number;
  /** Leaf: own play count. Container: 0 (not meaningful for a roll-up). */
  playCount: number;
  watchedAt: Date | null;
  updatedAt: Date | null;
  /** Container only (0 for leaves). Total descendant episodes. */
  episodeCount: number;
  /** Container only (0 for leaves). Descendant episodes marked watched. */
  watchedEpisodeCount: number;
  /** Container only (null for leaves). First unwatched episode in play order. */
  nextUnwatchedId: string | null;
}

/** Result of a mark-(un)watched cascade. */
export interface TreeWatchedSummary {
  itemId: string;
  type: MediaItemType;
  watched: boolean;
  /** Number of leaf (episode/movie) states written by the cascade. */
  affectedCount: number;
}

/** One in-progress item for the Continue Watching row. */
export interface ContinueWatchingEntry {
  mediaItemId: string;
  positionMs: number;
  updatedAt: Date;
  item: {
    id: string;
    type: string;
    title: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    parentId: string | null;
    libraryId: string;
    posterPath: string | null;
    runtimeMs: number | null;
    /** For the parental-controls filter (an episode inherits its show's). */
    contentRating: string | null;
  };
}

function toView(state: WatchState): WatchStateView {
  return {
    mediaItemId: state.mediaItemId,
    positionMs: state.positionMs,
    watched: state.watched,
    watchedAt: state.watchedAt,
    playCount: state.playCount,
    updatedAt: state.updatedAt,
  };
}

function emptyView(mediaItemId: string): WatchStateView {
  return {
    mediaItemId,
    positionMs: 0,
    watched: false,
    watchedAt: null,
    playCount: 0,
    updatedAt: null,
  };
}

/**
 * Records a playback position for one item. Upserts the row, clamping the
 * position to >= 0. Auto-marks watched when the position reaches
 * WATCHED_THRESHOLD of a known duration (explicit `durationMs`, else the
 * item's `runtimeMs`); an unknown duration leaves the watched flag untouched.
 * playCount is bumped only on the unwatched -> watched transition.
 */
export async function reportProgress(
  userId: string,
  mediaItemId: string,
  positionMs: number,
  durationMs?: number | null,
): Promise<WatchStateView> {
  const prisma = getPrisma();
  const clamped = Math.max(0, Math.trunc(positionMs));

  let duration = durationMs ?? undefined;
  if (duration === undefined) {
    const item = await prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { runtimeMs: true },
    });
    duration = item?.runtimeMs ?? undefined;
  }

  const existing = await prisma.watchState.findUnique({
    where: { userId_mediaItemId: { userId, mediaItemId } },
  });

  const wasWatched = existing?.watched ?? false;
  const reachedEnd =
    duration !== undefined && duration > 0 && clamped >= duration * WATCHED_THRESHOLD;
  const nowWatched = wasWatched || reachedEnd;
  const gainedWatched = !wasWatched && nowWatched;
  const now = new Date();
  const watchedAt = nowWatched ? (existing?.watchedAt ?? now) : (existing?.watchedAt ?? null);

  const state = await prisma.watchState.upsert({
    where: { userId_mediaItemId: { userId, mediaItemId } },
    create: {
      userId,
      mediaItemId,
      positionMs: clamped,
      watched: nowWatched,
      watchedAt: nowWatched ? now : null,
      playCount: nowWatched ? 1 : 0,
    },
    update: {
      positionMs: clamped,
      watched: nowWatched,
      watchedAt,
      playCount: (existing?.playCount ?? 0) + (gainedWatched ? 1 : 0),
    },
  });

  return toView(state);
}

/**
 * Applies a watched flag to a set of items in one transaction with the
 * canonical semantics: marking watched resets position to 0, sets watchedAt
 * and increments playCount (creating rows for items with none); unmarking
 * clears watched/watchedAt and resets position (never creating a row — an
 * absent row already reads as unwatched).
 */
async function applyWatchedToItems(
  userId: string,
  ids: readonly string[],
  watched: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const prisma = getPrisma();
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    if (!watched) {
      await tx.watchState.updateMany({
        where: { userId, mediaItemId: { in: [...ids] } },
        data: { watched: false, positionMs: 0, watchedAt: null },
      });
      return;
    }

    const existing = await tx.watchState.findMany({
      where: { userId, mediaItemId: { in: [...ids] } },
      select: { mediaItemId: true },
    });
    const existingIds = new Set(existing.map((row) => row.mediaItemId));

    if (existingIds.size > 0) {
      await tx.watchState.updateMany({
        where: { userId, mediaItemId: { in: [...existingIds] } },
        data: { watched: true, positionMs: 0, watchedAt: now, playCount: { increment: 1 } },
      });
    }

    const missing = ids.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      await tx.watchState.createMany({
        data: missing.map((mediaItemId) => ({
          userId,
          mediaItemId,
          watched: true,
          positionMs: 0,
          watchedAt: now,
          playCount: 1,
        })),
      });
    }
  });
}

/**
 * Explicitly (un)marks a single item. Marking watched resets the resume
 * position to 0 and increments playCount; unmarking clears watchedAt and the
 * position. Returns the resulting row view.
 */
export async function setWatched(
  userId: string,
  mediaItemId: string,
  watched: boolean,
): Promise<WatchStateView> {
  await applyWatchedToItems(userId, [mediaItemId], watched);
  return getState(userId, mediaItemId);
}

/**
 * Removes this user's watch state for one item ("remove from history"). Uses
 * deleteMany so it is idempotent — clearing an item with no stored row is a
 * no-op, never an error. Callers gate access (assertMediaItemAccess) first, so
 * this never leaks whether the item exists. Returns whether a row was deleted.
 */
export async function clearWatchState(userId: string, mediaItemId: string): Promise<boolean> {
  const result = await getPrisma().watchState.deleteMany({ where: { userId, mediaItemId } });
  return result.count > 0;
}

/** This user's raw state for one item (a zeroed view when no row exists). */
export async function getState(userId: string, mediaItemId: string): Promise<WatchStateView> {
  const state = await getPrisma().watchState.findUnique({
    where: { userId_mediaItemId: { userId, mediaItemId } },
  });
  return state === null ? emptyView(mediaItemId) : toView(state);
}

/**
 * This user's states for many items, keyed by mediaItemId. Only ids with a
 * stored row appear in the map (absent = unwatched, position 0). Callers must
 * restrict `ids` to items the user can access before calling.
 */
export async function getStatesForItems(
  userId: string,
  ids: readonly string[],
): Promise<Map<string, WatchStateView>> {
  if (ids.length === 0) return new Map();
  const rows = await getPrisma().watchState.findMany({
    where: { userId, mediaItemId: { in: [...ids] } },
  });
  return new Map(rows.map((row) => [row.mediaItemId, toView(row)]));
}

/** Descendant episode ids for a container, in stable play order (season, episode). */
async function orderedEpisodeIds(itemId: string, type: MediaItemType): Promise<string[]> {
  const prisma = getPrisma();

  if (type === 'season') {
    const episodes = await prisma.mediaItem.findMany({
      where: { parentId: itemId, type: 'episode' },
      orderBy: [{ episodeNumber: 'asc' }, { absoluteEpisodeNumber: 'asc' }, { title: 'asc' }],
      select: { id: true },
    });
    return episodes.map((episode) => episode.id);
  }

  // Show: episodes live under its seasons (and, defensively, directly under
  // the show for season-less layouts). Ordered across seasons.
  const seasons = await prisma.mediaItem.findMany({
    where: { parentId: itemId, type: 'season' },
    select: { id: true },
  });
  const parentIds = [itemId, ...seasons.map((season) => season.id)];
  const episodes = await prisma.mediaItem.findMany({
    where: { parentId: { in: parentIds }, type: 'episode' },
    orderBy: [
      { seasonNumber: 'asc' },
      { episodeNumber: 'asc' },
      { absoluteEpisodeNumber: 'asc' },
      { title: 'asc' },
    ],
    select: { id: true },
  });
  return episodes.map((episode) => episode.id);
}

/**
 * Marks an item watched/unwatched, cascading containers to every descendant
 * episode. A movie or episode marks only itself; a season or show marks all of
 * its descendant episodes (its own "watched" is always derived, never stored).
 */
export async function markTreeWatched(
  userId: string,
  itemId: string,
  watched: boolean,
): Promise<TreeWatchedSummary> {
  const item = await getPrisma().mediaItem.findUnique({
    where: { id: itemId },
    select: { id: true, type: true },
  });
  const type = (item?.type ?? 'movie') as MediaItemType;

  const targetIds =
    type === 'movie' || type === 'episode' ? [itemId] : await orderedEpisodeIds(itemId, type);

  await applyWatchedToItems(userId, targetIds, watched);
  return { itemId, type, watched, affectedCount: targetIds.length };
}

/**
 * Unified state for the detail page. Leaves return their own row; containers
 * return derived watched + episode roll-up + the next unwatched episode (and
 * its resume position), computed in play order.
 */
export async function getItemState(
  userId: string,
  item: { id: string; type: string },
): Promise<AggregateStateView> {
  const type = item.type as MediaItemType;

  if (type === 'movie' || type === 'episode') {
    const state = await getState(userId, item.id);
    return {
      mediaItemId: item.id,
      type,
      watched: state.watched,
      positionMs: state.positionMs,
      playCount: state.playCount,
      watchedAt: state.watchedAt,
      updatedAt: state.updatedAt,
      episodeCount: 0,
      watchedEpisodeCount: 0,
      nextUnwatchedId: null,
    };
  }

  const episodeIds = await orderedEpisodeIds(item.id, type);
  const states = await getStatesForItems(userId, episodeIds);

  let watchedEpisodeCount = 0;
  let nextUnwatchedId: string | null = null;
  let resumeMs = 0;
  for (const episodeId of episodeIds) {
    const state = states.get(episodeId);
    if (state?.watched ?? false) {
      watchedEpisodeCount += 1;
    } else if (nextUnwatchedId === null) {
      nextUnwatchedId = episodeId;
      resumeMs = state?.positionMs ?? 0;
    }
  }

  return {
    mediaItemId: item.id,
    type,
    watched: episodeIds.length > 0 && watchedEpisodeCount === episodeIds.length,
    positionMs: resumeMs,
    playCount: 0,
    watchedAt: null,
    updatedAt: null,
    episodeCount: episodeIds.length,
    watchedEpisodeCount,
    nextUnwatchedId,
  };
}

/**
 * This user's in-progress items (position > 0, not watched) across the given
 * accessible libraries, most-recently-updated first. Restricted to playable
 * leaf types so container rows never surface here.
 */
export async function getContinueWatching(
  userId: string,
  libraryIds: readonly string[],
  limit: number,
): Promise<ContinueWatchingEntry[]> {
  if (libraryIds.length === 0) return [];

  const rows = await getPrisma().watchState.findMany({
    where: {
      userId,
      watched: false,
      positionMs: { gt: 0 },
      mediaItem: { libraryId: { in: [...libraryIds] }, type: { in: ['movie', 'episode'] } },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: {
      mediaItem: {
        select: {
          id: true,
          type: true,
          title: true,
          seasonNumber: true,
          episodeNumber: true,
          parentId: true,
          libraryId: true,
          posterPath: true,
          runtimeMs: true,
          contentRating: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    mediaItemId: row.mediaItemId,
    positionMs: row.positionMs,
    updatedAt: row.updatedAt,
    item: row.mediaItem,
  }));
}
