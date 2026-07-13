import { useState } from 'react';
import { Link } from 'react-router';

import { useCollections, type Collection } from '../api/collections';
import { artworkSrc } from '../api/media';
import { AuthImage } from '../components/AuthImage';
import { ErrorState } from '../components/ErrorState';
import { EmptyState, Page, PageHeader } from '../components/Page';
import styles from './CollectionsPage.module.css';

// Browse page for `/collections`: a poster grid of every collection visible to
// the user (grouped movies + auto-linked TMDB franchises). Each card links to
// the collection's member grid at `/collections/:id`.

const SKELETON_COUNT = 8;

function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/** One collection tile: poster (or title fallback) + name + accessible count. */
function CollectionCard({ collection }: { collection: Collection }) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = artworkSrc(collection.posterUrl, 'w400');
  const showFallback = src === null || imageFailed;
  const countLabel = itemCountLabel(collection.itemCount);

  return (
    <Link
      to={`/collections/${collection.id}`}
      className={styles.card}
      aria-label={`${collection.name}, ${countLabel}`}
    >
      <div className={styles.poster}>
        {showFallback ? (
          <div className={styles.fallback} aria-hidden="true">
            <span className={styles.fallbackTitle}>{collection.name}</span>
          </div>
        ) : (
          <AuthImage
            className={styles.image}
            src={src}
            alt={collection.name}
            onError={() => setImageFailed(true)}
          />
        )}
        <span className={styles.countBadge}>{collection.itemCount}</span>
      </div>
      <div className={styles.caption}>
        <span className={styles.title}>{collection.name}</span>
        <span className={styles.count}>{countLabel}</span>
      </div>
    </Link>
  );
}

function SkeletonGrid() {
  return (
    <ul className={styles.grid} role="status" aria-label="Loading collections">
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <li key={index} className={styles.skeleton} data-testid="collection-skeleton">
          <div className={styles.skeletonPoster} />
          <div className={styles.skeletonLine} />
        </li>
      ))}
    </ul>
  );
}

export function CollectionsPage() {
  const query = useCollections();

  return (
    <Page>
      <PageHeader title="Collections" subtitle="Grouped movies and franchises." />

      {query.isPending && <SkeletonGrid />}

      {query.isError && (
        <ErrorState
          title="Couldn't load collections"
          message="Something went wrong while fetching your collections. Please try again."
          onRetry={() => void query.refetch()}
        />
      )}

      {query.isSuccess && query.data.length === 0 && (
        <EmptyState
          title="No collections yet"
          message="Collections group related movies. An admin can create one, or they appear automatically from TMDB franchise data as your movies are scanned."
        />
      )}

      {query.isSuccess && query.data.length > 0 && (
        <ul className={styles.grid}>
          {query.data.map((collection) => (
            <li key={collection.id} className={styles.gridItem}>
              <CollectionCard collection={collection} />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
