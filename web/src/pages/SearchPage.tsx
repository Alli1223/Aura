import { useSearchParams } from 'react-router';

import type { MediaItem } from '../api/media';
import { useSearch } from '../api/search';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/Page';
import { PosterCard } from '../components/PosterCard';
import styles from './SearchPage.module.css';

// Full search results page at /search?q=. The query is driven entirely by the
// URL `q` param (so a result page is shareable/back-navigable), echoed in the
// heading, and rendered as a PosterCard grid reusing the browse card. Loading,
// empty and error states mirror the library browse view.

const SKELETON_COUNT = 12;

export function SearchPage() {
  const [searchParams] = useSearchParams();
  const rawQuery = searchParams.get('q') ?? '';
  const query = rawQuery.trim();

  // minLength 1: the full page honours any non-empty query (the dropdown gates
  // at 2 chars, but a shared/typed URL may carry a single-character term).
  const search = useSearch(query, { minLength: 1 });
  const results = search.data?.results ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Search</h1>
        {query !== '' && (
          <p className={styles.subtitle}>
            Results for <span className={styles.term}>“{query}”</span>
            {search.isSuccess && ` — ${results.length} ${results.length === 1 ? 'result' : 'results'}`}
          </p>
        )}
      </header>

      <SearchBody query={query} search={search} results={results} />
    </div>
  );
}

function SearchBody({
  query,
  search,
  results,
}: {
  query: string;
  search: ReturnType<typeof useSearch>;
  results: MediaItem[];
}) {
  if (query === '') {
    return (
      <EmptyState
        title="Search your libraries"
        message="Find movies and shows by title, or by genre, across everything you can access."
      />
    );
  }

  if (search.isPending) {
    return <SkeletonGrid />;
  }

  if (search.isError) {
    return (
      <ErrorState
        title="Couldn't run your search"
        message="Something went wrong while searching. Please try again."
        onRetry={() => void search.refetch()}
      />
    );
  }

  if (results.length === 0) {
    return (
      <EmptyState title="No results" message={`Nothing matched “${query}”. Try a different search.`} />
    );
  }

  return (
    <ul className={styles.grid}>
      {results.map((item) => (
        <li key={item.id} className={styles.gridItem}>
          <PosterCard item={item} />
        </li>
      ))}
    </ul>
  );
}

function SkeletonGrid() {
  return (
    <div className={styles.grid} role="status" aria-label="Searching">
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <div key={index} className={styles.skeleton} data-testid="search-skeleton">
          <div className={styles.skeletonPoster} />
          <div className={styles.skeletonLine} />
        </div>
      ))}
    </div>
  );
}
