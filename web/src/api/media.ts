import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { apiRequest } from './client';

// Reusable media data layer over the browse API (server routes/media.ts). Owns
// the typed DTOs mirroring the server's SerializedItem, the request builders,
// the artwork-URL helper and the TanStack Query hooks. Later web screens
// (media-detail, home-screen) import from here — keep it faithful to the server
// contract and free of screen-specific concerns.

// ---- DTOs (mirror server SerializedItem / ListLibraryItemsResult) -----------

/** Watch-state overlay attached to every serialized item. */
export interface ItemWatchState {
  /** Leaf: own flag. Container: true iff it has episodes and all are watched. */
  watched: boolean;
  /** Leaf: resume position (ms). Container: next-unwatched episode's position. */
  positionMs: number;
  /** Container only (0 for leaves). Total descendant episodes. */
  episodeCount: number;
  /** Container only (0 for leaves). Descendant episodes marked watched. */
  watchedEpisodeCount: number;
  /** Container only (null for leaves). First unwatched episode in play order. */
  nextUnwatchedId: string | null;
}

/** A movie, show, season or episode. */
export type MediaItemType = 'movie' | 'show' | 'season' | 'episode';

/**
 * The safe browse projection of a media item, matching the server's
 * SerializedItem. `addedAt` arrives as an ISO string over JSON (a Date on the
 * server). Artwork URLs are already the app's artwork route (or null).
 */
export interface MediaItem {
  id: string;
  libraryId: string;
  type: MediaItemType | string;
  title: string;
  sortTitle: string;
  year: number | null;
  overview: string | null;
  tagline: string | null;
  runtimeMs: number | null;
  contentRating: string | null;
  communityRating: number | null;
  genres: string[];
  /** The app's artwork route (`/api/items/:id/artwork/poster`), or null. */
  posterUrl: string | null;
  /** The app's artwork route (`/api/items/:id/artwork/backdrop`), or null. */
  backdropUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  absoluteEpisodeNumber: number | null;
  addedAt: string;
  watchState: ItemWatchState;
}

/** A page of a library's top-level items. */
export interface LibraryItemsPage {
  items: MediaItem[];
  page: number;
  pageSize: number;
  total: number;
}

// ---- Request params ---------------------------------------------------------

export type SortField = 'title' | 'year' | 'added' | 'rating';
export type SortOrder = 'asc' | 'desc';
/** Server watched filter encoding: 'all' (default), 'true', 'false'. */
export type WatchedFilter = 'all' | 'true' | 'false';

/** Query params for the paginated library listing (all optional). */
export interface LibraryItemsParams {
  sort?: SortField;
  order?: SortOrder;
  genre?: string;
  year?: number;
  watched?: WatchedFilter;
  page?: number;
  pageSize?: number;
  search?: string;
}

/** Server default page size (see PAGE_SIZE_DEFAULT in routes/media.ts). */
export const DEFAULT_PAGE_SIZE = 48;

/** Listing identity minus pagination — the shape used to key an infinite query. */
export type LibraryListingParams = Omit<LibraryItemsParams, 'page'>;

// ---- Artwork ----------------------------------------------------------------

/** Fixed artwork size buckets the server's artwork route accepts. */
export type ArtworkSize = 'w200' | 'w400' | 'w800' | 'original';

export const DEFAULT_POSTER_SIZE: ArtworkSize = 'w400';

/**
 * Resolves a SerializedItem `posterUrl`/`backdropUrl` to a concrete `<img>`
 * src at a fixed size bucket. Returns null when the item has no artwork of that
 * kind, so callers render a placeholder tile instead of a broken image.
 */
export function artworkSrc(url: string | null, size: ArtworkSize = DEFAULT_POSTER_SIZE): string | null {
  if (url === null || url === '') return null;
  return `${url}?size=${size}`;
}

// ---- Client -----------------------------------------------------------------

/** Serialises listing params to a query string, omitting empties and defaults. */
function buildItemsQuery(params: LibraryItemsParams): string {
  const search = new URLSearchParams();
  if (params.sort !== undefined) search.set('sort', params.sort);
  if (params.order !== undefined) search.set('order', params.order);
  if (params.genre !== undefined && params.genre !== '') search.set('genre', params.genre);
  if (params.year !== undefined) search.set('year', String(params.year));
  if (params.watched !== undefined && params.watched !== 'all') {
    search.set('watched', params.watched);
  }
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.pageSize !== undefined) search.set('pageSize', String(params.pageSize));
  if (params.search !== undefined && params.search !== '') search.set('search', params.search);
  const qs = search.toString();
  return qs === '' ? '' : `?${qs}`;
}

/** GET /api/libraries/:id/items — one page of a library's top-level items. */
export function getLibraryItems(
  libraryId: string,
  params: LibraryItemsParams = {},
): Promise<LibraryItemsPage> {
  return apiRequest<LibraryItemsPage>(
    `/libraries/${encodeURIComponent(libraryId)}/items${buildItemsQuery(params)}`,
  );
}

// ---- Query keys -------------------------------------------------------------

export const mediaKeys = {
  all: ['media'] as const,
  libraryItems: (libraryId: string, params: LibraryItemsParams) =>
    ['media', 'library-items', libraryId, params] as const,
  libraryItemsInfinite: (libraryId: string, params: LibraryListingParams) =>
    ['media', 'library-items-infinite', libraryId, params] as const,
};

// ---- Hooks ------------------------------------------------------------------

/**
 * One page of a library's items. `keepPreviousData` keeps the last page visible
 * while a new page/filter loads, so paging and filtering don't flash empty.
 */
export function useLibraryItems(
  libraryId: string,
  params: LibraryItemsParams = {},
  options: { enabled?: boolean } = {},
): UseQueryResult<LibraryItemsPage> {
  return useQuery({
    queryKey: mediaKeys.libraryItems(libraryId, params),
    queryFn: () => getLibraryItems(libraryId, params),
    enabled: (options.enabled ?? true) && libraryId !== '',
    placeholderData: keepPreviousData,
  });
}

/**
 * The infinite-scroll variant powering the browse grid: appends successive
 * pages, stopping once every item has been loaded (page * pageSize >= total).
 * `page` is supplied by the query as the page param, so it must not appear in
 * `params`.
 */
export function useLibraryItemsInfinite(
  libraryId: string,
  params: LibraryListingParams = {},
  options: { enabled?: boolean } = {},
): UseInfiniteQueryResult<InfiniteData<LibraryItemsPage>, Error> {
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: mediaKeys.libraryItemsInfinite(libraryId, { ...params, pageSize }),
    queryFn: ({ pageParam }) =>
      getLibraryItems(libraryId, { ...params, pageSize, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const loaded = lastPage.page * lastPage.pageSize;
      return loaded < lastPage.total ? lastPage.page + 1 : undefined;
    },
    enabled: (options.enabled ?? true) && libraryId !== '',
  });
}
