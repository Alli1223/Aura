import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { apiRequest } from './client';
import { homeKeys } from './home';
import type { MediaItem } from './media';

// Data layer for the per-user watch history:
//   GET    /api/history?limit=&page=  → { items, page, pageSize, total }
//   DELETE /api/history/:itemId       → 204 (remove from history)
// History is derived server-side from WatchState (there is no event log): the
// items the caller has watched or started, most-recent activity first. Each
// entry carries the serialized MediaItem (so PosterCard can render it), its own
// watch state and the owning show's title for episodes.

/** Per-row watch state for a history entry (mirrors the server HistoryWatchState). */
export interface HistoryWatchState {
  positionMs: number;
  watched: boolean;
  /** ISO string over JSON (a Date on the server), or null when never watched. */
  watchedAt: string | null;
  playCount: number;
  /** The row's last-touched time — the recency the list is ordered by (ISO). */
  lastActivity: string;
}

/** One history row: the item, its watch state and (for episodes) show context. */
export interface HistoryEntry {
  item: MediaItem;
  watchState: HistoryWatchState;
  /** Episode only (null for movies): its show's id + title. */
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

/** Default history page size (mirrors HISTORY_DEFAULT_LIMIT in routes/history.ts). */
export const HISTORY_PAGE_SIZE = 24;

// ---- Client -----------------------------------------------------------------

/** GET /api/history — one page of the caller's history. */
export function getHistory(page: number, limit: number = HISTORY_PAGE_SIZE): Promise<HistoryPage> {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) });
  return apiRequest<HistoryPage>(`/history?${query.toString()}`);
}

/** DELETE /api/history/:itemId — remove one item from the caller's history. */
export function deleteHistoryItem(itemId: string): Promise<void> {
  return apiRequest<void>(`/history/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
}

// ---- Query keys -------------------------------------------------------------

export const historyKeys = {
  all: ['history'] as const,
  page: (page: number, limit: number) => ['history', page, limit] as const,
};

// ---- Hooks ------------------------------------------------------------------

/**
 * One page of the caller's watch history. `keepPreviousData` keeps the current
 * page visible while the next one loads so paging doesn't flash empty.
 */
export function useHistory(
  page: number,
  limit: number = HISTORY_PAGE_SIZE,
): UseQueryResult<HistoryPage> {
  return useQuery({
    queryKey: historyKeys.page(page, limit),
    queryFn: () => getHistory(page, limit),
    placeholderData: keepPreviousData,
  });
}

/**
 * Removes one item from history. Optimistically drops the row from every cached
 * history page for a snappy list, reverting on error, then reconciles on settle.
 * Also refreshes Continue Watching, which the same watch state feeds.
 */
export function useDeleteHistoryItem(): UseMutationResult<
  void,
  Error,
  string,
  { previous: [readonly unknown[], HistoryPage | undefined][] }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId) => deleteHistoryItem(itemId),
    onMutate: async (itemId) => {
      await queryClient.cancelQueries({ queryKey: historyKeys.all });
      const previous = queryClient.getQueriesData<HistoryPage>({ queryKey: historyKeys.all });
      queryClient.setQueriesData<HistoryPage>({ queryKey: historyKeys.all }, (old) =>
        old === undefined
          ? old
          : {
              ...old,
              items: old.items.filter((entry) => entry.item.id !== itemId),
              total: Math.max(0, old.total - 1),
            },
      );
      return { previous };
    },
    onError: (_error, _itemId, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: historyKeys.all });
      void queryClient.invalidateQueries({ queryKey: homeKeys.all });
    },
  });
}
