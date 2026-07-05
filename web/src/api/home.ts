import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from './client';
import type { MediaItem } from './media';

// Home-screen data layer over the server's home/watch feeds:
//   GET /api/continue-watching?limit=            (watch.ts)   → { items }
//   GET /api/home/recently-added?limit=          (media.ts)   → { items }
//   GET /api/libraries/:id/recently-added?limit= (media.ts)   → { items }
// The recently-added feeds already serialize to MediaItem (SerializedItem). The
// continue-watching feed carries a leaner in-progress entry, which is adapted to
// MediaItem here so the shared PosterCard can render it. Screen-specific layout
// (row derivation, On Deck) lives in the HomePage; this module stays a faithful
// mirror of the server contract.

// ---- Per-row caps -----------------------------------------------------------
// The server enforces its own maxima; these keep each row to a sensible length.

export const CONTINUE_WATCHING_LIMIT = 20;
export const RECENTLY_ADDED_LIMIT = 20;

// ---- Continue Watching DTO --------------------------------------------------

/**
 * One in-progress item from GET /api/continue-watching (mirrors the server's
 * ContinueWatchingEntry in lib/watch-state.ts). Only playable leaves (movie /
 * episode) appear. `updatedAt` arrives as an ISO string over JSON (a Date on the
 * server); `posterPath` is the server-internal path — its mere presence signals
 * a poster exists, and the public artwork URL is derived from the item id.
 */
export interface ContinueWatchingEntry {
  mediaItemId: string;
  positionMs: number;
  updatedAt: string;
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
  };
}

/**
 * Adapts a continue-watching entry to the MediaItem shape PosterCard consumes.
 * The feed exposes a raw `posterPath` (not the artwork route), so the app's
 * artwork URL is derived from the item id when a poster exists. `positionMs` is
 * threaded into the watch state so the card renders its in-progress bar, and the
 * entry's `updatedAt` stands in for `addedAt` (unused by the card).
 */
export function continueWatchingToMediaItem(entry: ContinueWatchingEntry): MediaItem {
  const { item } = entry;
  const hasPoster = item.posterPath !== null && item.posterPath !== '';
  return {
    id: item.id,
    libraryId: item.libraryId,
    type: item.type,
    title: item.title,
    sortTitle: item.title,
    year: null,
    overview: null,
    tagline: null,
    runtimeMs: item.runtimeMs,
    contentRating: null,
    communityRating: null,
    genres: [],
    posterUrl: hasPoster ? `/api/items/${item.id}/artwork/poster` : null,
    backdropUrl: null,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    absoluteEpisodeNumber: null,
    addedAt: entry.updatedAt,
    watchState: {
      watched: false,
      positionMs: entry.positionMs,
      episodeCount: 0,
      watchedEpisodeCount: 0,
      nextUnwatchedId: null,
    },
  };
}

/**
 * On Deck: the "next unwatched episode" surfaced from show-level state. A show
 * qualifies when it has been started (some episodes watched, or a partially
 * watched next episode) but is not finished and still has a next episode queued
 * (`nextUnwatchedId`). Derived from the cross-library recently-added feed — the
 * only feed that exposes container watch-state — because the continue-watching
 * feed returns leaf items without a show's `nextUnwatchedId`.
 */
export function deriveOnDeck(items: MediaItem[]): MediaItem[] {
  return items.filter((item) => {
    const state = item.watchState;
    if (item.type !== 'show') return false;
    if (state.watched || state.nextUnwatchedId === null) return false;
    if (state.episodeCount <= 0) return false;
    return state.watchedEpisodeCount > 0 || state.positionMs > 0;
  });
}

// ---- Client -----------------------------------------------------------------

function buildLimitQuery(limit: number | undefined): string {
  return limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
}

/** GET /api/continue-watching — in-progress items, adapted to MediaItem. */
export async function getContinueWatching(limit?: number): Promise<MediaItem[]> {
  const data = await apiRequest<{ items: ContinueWatchingEntry[] }>(
    `/continue-watching${buildLimitQuery(limit)}`,
  );
  return data.items.map(continueWatchingToMediaItem);
}

/** GET /api/home/recently-added — recently added across every permitted library. */
export async function getRecentlyAdded(limit?: number): Promise<MediaItem[]> {
  const data = await apiRequest<{ items: MediaItem[] }>(
    `/home/recently-added${buildLimitQuery(limit)}`,
  );
  return data.items;
}

/** GET /api/libraries/:id/recently-added — recently added within one library. */
export async function getLibraryRecentlyAdded(
  libraryId: string,
  limit?: number,
): Promise<MediaItem[]> {
  const data = await apiRequest<{ items: MediaItem[] }>(
    `/libraries/${encodeURIComponent(libraryId)}/recently-added${buildLimitQuery(limit)}`,
  );
  return data.items;
}

// ---- Query keys -------------------------------------------------------------

export const homeKeys = {
  all: ['home'] as const,
  continueWatching: (limit: number) => ['home', 'continue-watching', limit] as const,
  recentlyAdded: (limit: number) => ['home', 'recently-added', limit] as const,
  libraryRecentlyAdded: (libraryId: string, limit: number) =>
    ['home', 'library-recently-added', libraryId, limit] as const,
};

// ---- Hooks ------------------------------------------------------------------

/** In-progress items across permitted libraries (Continue Watching row). */
export function useContinueWatching(
  limit: number = CONTINUE_WATCHING_LIMIT,
): UseQueryResult<MediaItem[]> {
  return useQuery({
    queryKey: homeKeys.continueWatching(limit),
    queryFn: () => getContinueWatching(limit),
  });
}

/** Recently added across every permitted library (cross-library row + On Deck). */
export function useRecentlyAdded(
  limit: number = RECENTLY_ADDED_LIMIT,
): UseQueryResult<MediaItem[]> {
  return useQuery({
    queryKey: homeKeys.recentlyAdded(limit),
    queryFn: () => getRecentlyAdded(limit),
  });
}

/** Recently added within one library (per-library row). */
export function useLibraryRecentlyAdded(
  libraryId: string,
  limit: number = RECENTLY_ADDED_LIMIT,
): UseQueryResult<MediaItem[]> {
  return useQuery({
    queryKey: homeKeys.libraryRecentlyAdded(libraryId, limit),
    queryFn: () => getLibraryRecentlyAdded(libraryId, limit),
    enabled: libraryId !== '',
  });
}
