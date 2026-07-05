import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';

import type { RefObject } from 'react';

import { ApiError } from '../api/client';
import {
  DEFAULT_PAGE_SIZE,
  useLibraryItemsInfinite,
  type LibraryListingParams,
  type MediaItem,
  type SortField,
  type SortOrder,
  type WatchedFilter,
} from '../api/media';
import { useLibraries } from '../api/queries';
import { ErrorState } from '../components/ErrorState';
import { SearchIcon } from '../components/Icons';
import { EmptyState } from '../components/Page';
import { PosterCard } from '../components/PosterCard';
import styles from './LibraryPage.module.css';

const SEARCH_DEBOUNCE_MS = 300;
const SKELETON_COUNT = 12;

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'year', label: 'Year' },
  { value: 'added', label: 'Date Added' },
  { value: 'rating', label: 'Rating' },
];

const WATCHED_OPTIONS: { value: WatchedFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'false', label: 'Unwatched' },
  { value: 'true', label: 'Watched' },
];

function parseSort(value: string | null): SortField {
  return value === 'year' || value === 'added' || value === 'rating' ? value : 'title';
}

function parseOrder(value: string | null): SortOrder {
  return value === 'desc' ? 'desc' : 'asc';
}

function parseWatched(value: string | null): WatchedFilter {
  return value === 'true' || value === 'false' ? value : 'all';
}

/**
 * Route entry for `/library/:id`. Keyed on the id so switching libraries fully
 * remounts the browse view, resetting its local (search draft) state.
 */
export function LibraryPage() {
  const { id = '' } = useParams();
  return <LibraryBrowse key={id} libraryId={id} />;
}

/** Poster-grid browse view: toolbar (sort/order/filter/search) + infinite grid. */
function LibraryBrowse({ libraryId }: { libraryId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Control state derived from (and reflected back into) the URL query string.
  const sort = parseSort(searchParams.get('sort'));
  const order = parseOrder(searchParams.get('order'));
  const watched = parseWatched(searchParams.get('watched'));
  const genre = searchParams.get('genre') ?? '';
  const yearParam = searchParams.get('year') ?? '';
  const year = yearParam !== '' && Number.isFinite(Number(yearParam)) ? Number(yearParam) : undefined;
  const urlSearch = searchParams.get('search') ?? '';

  const setParams = useCallback(
    (updates: Record<string, string | null>, opts: { replace?: boolean } = {}) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: opts.replace ?? false },
      );
    },
    [setSearchParams],
  );

  // Debounced search: the input drives a draft; the URL `search` (and thus the
  // request) only updates after the user pauses typing.
  const [searchDraft, setSearchDraft] = useState(urlSearch);
  useEffect(() => {
    if (searchDraft === urlSearch) return;
    const timer = setTimeout(() => {
      setParams({ search: searchDraft || null }, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, urlSearch, setParams]);

  const listingParams: LibraryListingParams = {
    sort,
    order,
    genre: genre || undefined,
    year,
    watched,
    search: urlSearch || undefined,
    pageSize: DEFAULT_PAGE_SIZE,
  };
  const query = useLibraryItemsInfinite(libraryId, listingParams);

  const items = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;

  // Filter option lists derived from whatever has loaded (no distinct endpoint),
  // always including the active selection so it stays selectable.
  const availableGenres = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) for (const name of item.genres) set.add(name);
    if (genre !== '') set.add(genre);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items, genre]);

  const availableYears = useMemo(() => {
    const set = new Set<number>();
    for (const item of items) if (item.year !== null) set.add(item.year);
    if (year !== undefined) set.add(year);
    return [...set].sort((a, b) => b - a);
  }, [items, year]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const sentinelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const libraries = useLibraries();
  const library = libraries.data?.find((entry) => entry.id === libraryId);

  const isNotFound =
    query.isError && query.error instanceof ApiError && query.error.status === 404;

  if (isNotFound) {
    return (
      <div className={styles.browse}>
        <ErrorState
          title="Library not found"
          message="This library doesn't exist, or you don't have access to it."
        />
      </div>
    );
  }

  return (
    <div className={styles.browse}>
      <header className={styles.header}>
        <h1 className={styles.title}>{library?.name ?? 'Library'}</h1>
        {query.isSuccess && (
          <p className={styles.count}>
            {total} {total === 1 ? 'item' : 'items'}
          </p>
        )}
      </header>

      <div className={styles.toolbar} role="search">
        <div className={styles.searchBox}>
          <SearchIcon className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="Search this library"
            aria-label="Search this library"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </div>

        <div className={styles.controls}>
          <label className={styles.control}>
            <span className={styles.controlLabel}>Sort</span>
            <select
              className={styles.select}
              value={sort}
              onChange={(event) =>
                setParams({ sort: event.target.value === 'title' ? null : event.target.value })
              }
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={`btn btn-ghost ${styles.orderToggle}`}
            aria-label={`Sort direction: ${order === 'asc' ? 'ascending' : 'descending'}`}
            onClick={() => setParams({ order: order === 'asc' ? 'desc' : null })}
          >
            {order === 'asc' ? '↑ Asc' : '↓ Desc'}
          </button>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Genre</span>
            <select
              className={styles.select}
              value={genre}
              onChange={(event) => setParams({ genre: event.target.value || null })}
            >
              <option value="">All genres</option>
              {availableGenres.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Year</span>
            <select
              className={styles.select}
              value={year === undefined ? '' : String(year)}
              onChange={(event) => setParams({ year: event.target.value || null })}
            >
              <option value="">Any year</option>
              {availableYears.map((value) => (
                <option key={value} value={String(value)}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Watched</span>
            <select
              className={styles.select}
              value={watched}
              onChange={(event) =>
                setParams({ watched: event.target.value === 'all' ? null : event.target.value })
              }
            >
              {WATCHED_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <BrowseBody
        query={query}
        items={items}
        sentinelRef={sentinelRef}
        onLoadMore={() => void fetchNextPage()}
      />
    </div>
  );
}

/** The result region: skeleton → grid, plus empty / error / load-more states. */
function BrowseBody({
  query,
  items,
  sentinelRef,
  onLoadMore,
}: {
  query: ReturnType<typeof useLibraryItemsInfinite>;
  items: MediaItem[];
  sentinelRef: RefObject<HTMLButtonElement | null>;
  onLoadMore: () => void;
}) {
  if (query.isPending) {
    return <SkeletonGrid />;
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load this library"
        message="Something went wrong while fetching the media. Please try again."
        onRetry={() => void query.refetch()}
      />
    );
  }

  if (items.length === 0) {
    return <EmptyState title="No items match" message="Try adjusting your filters or search." />;
  }

  return (
    <>
      <ul className={styles.grid}>
        {items.map((item) => (
          <li key={item.id} className={styles.gridItem}>
            <PosterCard item={item} />
          </li>
        ))}
      </ul>

      {query.hasNextPage && (
        <div className={styles.loadMore}>
          <button
            ref={sentinelRef}
            type="button"
            className="btn btn-ghost"
            onClick={onLoadMore}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}

function SkeletonGrid() {
  return (
    <div className={styles.grid} role="status" aria-label="Loading media">
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <div key={index} className={styles.skeleton} data-testid="poster-skeleton">
          <div className={styles.skeletonPoster} />
          <div className={styles.skeletonLine} />
        </div>
      ))}
    </div>
  );
}
