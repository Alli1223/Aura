import { Link, useParams } from 'react-router';

import { ApiError } from '../api/client';
import { useCollection } from '../api/collections';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/Page';
import { PosterCard } from '../components/PosterCard';
import styles from './CollectionDetailPage.module.css';

// Detail page for `/collections/:id`: the collection's members rendered as a
// PosterCard grid in curated order. Only members the caller can access are
// returned by the server; an unknown or invisible collection is cloaked as a
// 404, which this page surfaces as a "not found" state.

const SKELETON_COUNT = 8;

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

function SkeletonGrid() {
  return (
    <ul className={styles.grid} role="status" aria-label="Loading collection">
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <li key={index} className={styles.gridItem} data-testid="collection-item-skeleton">
          <div className={styles.skeletonPoster} />
        </li>
      ))}
    </ul>
  );
}

/** Route entry: keyed on the id so switching collections fully remounts. */
export function CollectionDetailPage() {
  const { id = '' } = useParams();
  return <CollectionDetail key={id} id={id} />;
}

function CollectionDetail({ id }: { id: string }) {
  const query = useCollection(id);

  const isNotFound = query.isError && query.error instanceof ApiError && query.error.status === 404;
  if (isNotFound) {
    return (
      <div className={styles.page}>
        <Link to="/collections" className={styles.back}>
          &larr; Collections
        </Link>
        <ErrorState
          title="Collection not found"
          message="This collection doesn't exist, or none of its items are available to you."
        />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className={styles.page}>
        <Link to="/collections" className={styles.back}>
          &larr; Collections
        </Link>
        <ErrorState
          title="Couldn't load this collection"
          message="Something went wrong while fetching the collection. Please try again."
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Link to="/collections" className={styles.back}>
        &larr; Collections
      </Link>

      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{query.data?.collection.name ?? 'Collection'}</h1>
          {query.isSuccess && (
            <span className={styles.count}>{itemCountLabel(query.data.items.length)}</span>
          )}
        </div>
        {query.data?.collection.overview != null && query.data.collection.overview !== '' && (
          <p className={styles.overview}>{query.data.collection.overview}</p>
        )}
      </header>

      {query.isPending && <SkeletonGrid />}

      {query.isSuccess && query.data.items.length === 0 && (
        <EmptyState
          title="No items to show"
          message="This collection has no items you can access right now."
        />
      )}

      {query.isSuccess && query.data.items.length > 0 && (
        <ul className={styles.grid}>
          {query.data.items.map((item) => (
            <li key={item.id} className={styles.gridItem}>
              <PosterCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
