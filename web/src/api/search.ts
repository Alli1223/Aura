import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from './client';
import type { MediaItem } from './media';

// Search data layer over the server's GET /api/search (routes/search.ts). The
// endpoint returns the same safe SerializedItem shape as the browse API (so the
// shared PosterCard renders results directly), scoped to the caller's permitted
// libraries. Debouncing is the caller's concern — this hook only decides whether
// a query is worth firing (a non-empty, long-enough term).

/** Minimum query length before a search is issued (matches the dropdown gate). */
export const MIN_SEARCH_LENGTH = 2;

/** Default full-results page size; the server caps requests at 50. */
export const DEFAULT_SEARCH_LIMIT = 50;

/** Response of GET /api/search: the ranked results plus the trimmed query. */
export interface SearchResults {
  results: MediaItem[];
  query: string;
}

/** GET /api/search — access-scoped title/genre search, ranked and capped. */
export function searchMedia(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<SearchResults> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiRequest<SearchResults>(`/search?${params.toString()}`);
}

export const searchKeys = {
  all: ['search'] as const,
  query: (query: string, limit: number) => ['search', query, limit] as const,
};

export interface UseSearchOptions {
  /** Gate the query (e.g. dropdown closed). Defaults to true. */
  enabled?: boolean;
  /** Result cap to request (default DEFAULT_SEARCH_LIMIT). */
  limit?: number;
  /**
   * Minimum trimmed length before the query fires. Defaults to MIN_SEARCH_LENGTH
   * (the dropdown's 2-char gate); the full results page passes 1 so a shared URL
   * with a single-character term still searches.
   */
  minLength?: number;
}

/**
 * Runs a search for `query`. The caller is expected to debounce whatever it
 * passes in. The query only fires once the trimmed term meets `minLength` (and
 * the caller hasn't disabled it); `keepPreviousData` keeps the last results on
 * screen while the next term loads, so the dropdown doesn't flash empty.
 */
export function useSearch(
  query: string,
  { enabled = true, limit = DEFAULT_SEARCH_LIMIT, minLength = MIN_SEARCH_LENGTH }: UseSearchOptions = {},
): UseQueryResult<SearchResults> {
  const trimmed = query.trim();
  return useQuery({
    queryKey: searchKeys.query(trimmed, limit),
    queryFn: () => searchMedia(trimmed, limit),
    enabled: enabled && trimmed.length >= minLength,
    placeholderData: keepPreviousData,
  });
}
