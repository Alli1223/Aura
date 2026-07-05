import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { apiRequest } from './client';
import { mediaKeys, type MediaItem } from './media';

// Data layer for the media-detail screens over the server's item-detail /
// children / watch routes (server routes/media.ts + routes/watch.ts). It owns
// the detail DTOs (files + streams + episodes), the request builders, the
// TanStack Query hooks and the optimistic watched-toggle mutation. It reuses the
// shared MediaItem projection (== server SerializedItem) from api/media.ts and
// stays faithful to the server contract.

// ---- DTOs (mirror server media-query.ts) ------------------------------------

/** One audio track of a media file (the player's audio menu). */
export interface AudioStreamInfo {
  index: number;
  codec: string | null;
  channels: number | null;
  language: string | null;
  title: string | null;
  default: boolean;
}

/** One subtitle track of a media file (the player's subtitle menu). */
export interface SubtitleStreamInfo {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  forced: boolean;
}

/** A playable file/version of a movie or episode (no filesystem path leaked). */
export interface MediaFileInfo {
  id: string;
  container: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bitrate: number | null;
  videoCodec: string | null;
  /** Bytes, as a JSON number. */
  size: number;
  audioStreams: AudioStreamInfo[];
  subtitleStreams: SubtitleStreamInfo[];
}

/** A serialized episode carries the extra fields a play button needs. */
export interface DetailEpisode extends MediaItem {
  /** Whether the episode has at least one available (playable) file. */
  hasFile: boolean;
  /** The file the play button should stream, or null when none is available. */
  primaryMediaFileId: string | null;
}

/** Detail payload: the item plus the sub-collection relevant to its type. */
export interface ItemDetail {
  item: MediaItem;
  /** Movie/episode: its playable files. Containers: empty. */
  files: MediaFileInfo[];
  /** Show: its seasons with counts. Otherwise empty. */
  seasons: MediaItem[];
  /** Season: its episodes with play info. Otherwise empty. */
  episodes: DetailEpisode[];
}

/** A container's children: a show's seasons or a season's episodes. */
export type ChildItem = MediaItem | DetailEpisode;

/** Result of a mark-(un)watched cascade (server TreeWatchedSummary). */
export interface WatchedSummary {
  itemId: string;
  type: string;
  watched: boolean;
  /** Number of leaf (episode/movie) states written by the cascade. */
  affectedCount: number;
}

// ---- Query keys -------------------------------------------------------------
// Namespaced under the shared 'media' root so invalidating mediaKeys.all after a
// watch change refreshes the browse grid, detail and children in one call.

export const detailKeys = {
  detailRoot: ['media', 'item-detail'] as const,
  childrenRoot: ['media', 'item-children'] as const,
  detail: (itemId: string) => ['media', 'item-detail', itemId] as const,
  children: (itemId: string) => ['media', 'item-children', itemId] as const,
};

// ---- Requests ---------------------------------------------------------------

/** GET /api/items/:id — full detail for a movie, show or season. */
export function getItemDetail(itemId: string): Promise<ItemDetail> {
  return apiRequest<ItemDetail>(`/items/${encodeURIComponent(itemId)}`);
}

/** GET /api/items/:id/children — a show's seasons or a season's episodes. */
export async function getItemChildren(itemId: string): Promise<ChildItem[]> {
  const data = await apiRequest<{ items: ChildItem[] }>(
    `/items/${encodeURIComponent(itemId)}/children`,
  );
  return data.items;
}

/** PUT /api/items/:id/watched — (un)mark, cascading for containers. */
export async function setItemWatched(itemId: string, watched: boolean): Promise<WatchedSummary> {
  const data = await apiRequest<{ summary: WatchedSummary }>(
    `/items/${encodeURIComponent(itemId)}/watched`,
    { method: 'PUT', body: { watched } },
  );
  return data.summary;
}

// ---- Optimistic cache patching ----------------------------------------------
// A watched toggle updates every cached detail/children view that references the
// toggled item so the UI flips instantly, then invalidation reconciles with the
// server. Marking a container cascades to its episodes; toggling one episode
// re-derives its season's roll-up.

/** Applies a watched flag to one item, matching the server's reset semantics. */
function withWatched<T extends MediaItem>(item: T, watched: boolean): T {
  const state = item.watchState;
  const isContainer = item.type === 'show' || item.type === 'season' || state.episodeCount > 0;
  return {
    ...item,
    watchState: {
      ...state,
      watched,
      // markTreeWatched resets the resume position on both mark and unmark.
      positionMs: 0,
      ...(isContainer
        ? {
            watchedEpisodeCount: watched ? state.episodeCount : 0,
            nextUnwatchedId: watched ? null : state.nextUnwatchedId,
          }
        : {}),
    },
  };
}

/** Re-derives a container item's watch-state roll-up from its episodes. */
function rollUp(item: MediaItem, episodes: DetailEpisode[]): MediaItem {
  const episodeCount = episodes.length;
  let watchedEpisodeCount = 0;
  let nextUnwatchedId: string | null = null;
  let positionMs = 0;
  for (const episode of episodes) {
    if (episode.watchState.watched) {
      watchedEpisodeCount += 1;
    } else if (nextUnwatchedId === null) {
      nextUnwatchedId = episode.id;
      positionMs = episode.watchState.positionMs;
    }
  }
  return {
    ...item,
    watchState: {
      ...item.watchState,
      watched: episodeCount > 0 && watchedEpisodeCount === episodeCount,
      positionMs,
      episodeCount,
      watchedEpisodeCount,
      nextUnwatchedId,
    },
  };
}

/** Patches a cached detail payload for a toggled item; same ref when untouched. */
function patchDetail(detail: ItemDetail, targetId: string, watched: boolean): ItemDetail {
  if (detail.item.id === targetId) {
    if (detail.item.type === 'season' || detail.item.type === 'show') {
      const episodes = detail.episodes.map((episode) => withWatched(episode, watched));
      return { ...detail, episodes, item: rollUp(detail.item, episodes) };
    }
    return { ...detail, item: withWatched(detail.item, watched) };
  }
  if (detail.episodes.some((episode) => episode.id === targetId)) {
    const episodes = detail.episodes.map((episode) =>
      episode.id === targetId ? withWatched(episode, watched) : episode,
    );
    return { ...detail, episodes, item: rollUp(detail.item, episodes) };
  }
  return detail;
}

/** Patches a cached children list for a toggled item; same ref when untouched. */
function patchChildren(
  items: ChildItem[],
  containerId: string,
  targetId: string,
  watched: boolean,
): ChildItem[] {
  // The whole container was (un)marked: cascade to every child.
  if (containerId === targetId) {
    return items.map((child) => withWatched(child, watched));
  }
  if (!items.some((child) => child.id === targetId)) return items;
  return items.map((child) => (child.id === targetId ? withWatched(child, watched) : child));
}

// ---- Hooks ------------------------------------------------------------------

/** Full detail for one item (movie files, show seasons or season episodes). */
export function useItemDetail(
  itemId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ItemDetail> {
  return useQuery({
    queryKey: detailKeys.detail(itemId),
    queryFn: () => getItemDetail(itemId),
    enabled: (options.enabled ?? true) && itemId !== '',
  });
}

/** A container's children: a show's seasons or a season's episodes. */
export function useItemChildren(
  itemId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ChildItem[]> {
  return useQuery({
    queryKey: detailKeys.children(itemId),
    queryFn: () => getItemChildren(itemId),
    enabled: (options.enabled ?? true) && itemId !== '',
  });
}

/**
 * Toggles watched state for an item with an optimistic cache update. Patches
 * every cached detail/children view that references the item, then on settle
 * invalidates the item, browse and home queries so they reconcile with the
 * server (marking a container cascades to its descendant episodes).
 */
export function useSetWatched(itemId: string): UseMutationResult<WatchedSummary, Error, boolean> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (watched: boolean) => setItemWatched(itemId, watched),
    onMutate: async (watched: boolean) => {
      await queryClient.cancelQueries({ queryKey: detailKeys.detailRoot });
      await queryClient.cancelQueries({ queryKey: detailKeys.childrenRoot });

      const snapshots: [QueryKey, unknown][] = [];

      for (const [key, data] of queryClient.getQueriesData<ItemDetail>({
        queryKey: detailKeys.detailRoot,
      })) {
        if (data === undefined) continue;
        const patched = patchDetail(data, itemId, watched);
        if (patched !== data) {
          snapshots.push([key, data]);
          queryClient.setQueryData(key, patched);
        }
      }

      for (const [key, data] of queryClient.getQueriesData<ChildItem[]>({
        queryKey: detailKeys.childrenRoot,
      })) {
        if (data === undefined) continue;
        const containerId = String(key[2] ?? '');
        const patched = patchChildren(data, containerId, itemId, watched);
        if (patched !== data) {
          snapshots.push([key, data]);
          queryClient.setQueryData(key, patched);
        }
      }

      return { snapshots };
    },
    onError: (_error, _watched, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      // Item detail + children + browse grid all live under the 'media' root.
      void queryClient.invalidateQueries({ queryKey: mediaKeys.all });
      // Home feeds (continue-watching / recently-added) if they are mounted.
      void queryClient.invalidateQueries({ queryKey: ['continue-watching'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
    },
  });
}
