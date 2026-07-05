import { useId, type KeyboardEvent, type ReactNode } from 'react';

import {
  deriveOnDeck,
  useContinueWatching,
  useLibraryRecentlyAdded,
  useRecentlyAdded,
} from '../api/home';
import type { MediaItem } from '../api/media';
import { useLibraries } from '../api/queries';
import type { Library } from '../api/types';
import { useAuth } from '../auth/context';
import { ErrorState } from '../components/ErrorState';
import { EmptyState, Page, PageHeader } from '../components/Page';
import { PosterCard } from '../components/PosterCard';
import styles from './HomePage.module.css';

// Home screen: a stack of horizontal rows — Continue Watching, On Deck, a
// cross-library Recently Added row, then one Recently Added row per permitted
// library. Each row owns its own query so a single failing feed degrades to a
// retryable row rather than taking down the page. Empty rows are hidden.

const SKELETON_CARDS = 6;

/** How far the arrow keys nudge a rail (fraction of its visible width). */
const SCROLL_STEP_FRACTION = 0.8;

export function HomePage() {
  const { user } = useAuth();

  return (
    <Page>
      <PageHeader
        title={`Welcome back, ${user?.username ?? ''}`}
        subtitle="Pick up where you left off, or dive into what's new."
      />
      <HomeBody />
    </Page>
  );
}

/** Chooses between the loading, error, no-access and populated states. */
function HomeBody() {
  const libraries = useLibraries();

  if (libraries.isPending) {
    return <HomeSkeleton />;
  }

  if (libraries.isError) {
    return (
      <ErrorState
        title="Couldn't load your libraries"
        message="Something went wrong loading your home screen. Please try again."
        onRetry={() => void libraries.refetch()}
      />
    );
  }

  if (libraries.data.length === 0) {
    return (
      <EmptyState
        title="No libraries yet"
        message="Ask an admin for library access, then your Continue Watching and Recently Added rows will appear here."
      />
    );
  }

  return (
    <div className={styles.home}>
      <ContinueWatchingRow />
      <CrossLibraryRows />
      {libraries.data.map((library) => (
        <LibraryRow key={library.id} library={library} />
      ))}
    </div>
  );
}

/** Continue Watching: in-progress movies & episodes, most recent first. */
function ContinueWatchingRow() {
  const query = useContinueWatching();
  return (
    <MediaRow
      title="Continue Watching"
      items={query.data ?? []}
      isPending={query.isPending}
      isError={query.isError}
      onRetry={() => void query.refetch()}
    />
  );
}

/**
 * On Deck + the cross-library Recently Added row. Both read the same
 * recently-added feed (one request, shared cache): On Deck is the derived subset
 * of started-but-unfinished shows with a queued next episode.
 */
function CrossLibraryRows() {
  const query = useRecentlyAdded();
  const items = query.data ?? [];
  const onDeck = deriveOnDeck(items);

  return (
    <>
      <MediaRow
        title="On Deck"
        items={onDeck}
        isPending={query.isPending}
        isError={query.isError}
        onRetry={() => void query.refetch()}
      />
      <MediaRow
        title="Recently Added"
        items={items}
        isPending={query.isPending}
        isError={query.isError}
        onRetry={() => void query.refetch()}
      />
    </>
  );
}

/** One Recently Added row scoped to a single permitted library. */
function LibraryRow({ library }: { library: Library }) {
  const query = useLibraryRecentlyAdded(library.id);
  return (
    <MediaRow
      title={library.name}
      items={query.data ?? []}
      isPending={query.isPending}
      isError={query.isError}
      onRetry={() => void query.refetch()}
    />
  );
}

interface MediaRowProps {
  title: string;
  items: MediaItem[];
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
}

/**
 * A single home row. While loading it shows a skeleton rail; on failure a
 * compact retry (leaving sibling rows untouched); once loaded it renders the
 * poster rail, or nothing at all when the feed came back empty.
 */
function MediaRow({ title, items, isPending, isError, onRetry }: MediaRowProps) {
  const headingId = useId();

  if (isPending) {
    return (
      <RowSection title={title} headingId={headingId}>
        <RowSkeleton title={title} />
      </RowSection>
    );
  }

  if (isError) {
    return (
      <RowSection title={title} headingId={headingId}>
        <ErrorState
          title={`Couldn't load ${title}`}
          message="This row failed to load. The rest of your home screen is fine."
          onRetry={onRetry}
        />
      </RowSection>
    );
  }

  // Empty rows are hidden entirely (no heading, no rail).
  if (items.length === 0) {
    return null;
  }

  return (
    <RowSection title={title} headingId={headingId}>
      <Scroller labelledBy={headingId}>
        {items.map((item) => (
          <li key={item.id} className={styles.item}>
            <PosterCard item={item} />
          </li>
        ))}
      </Scroller>
    </RowSection>
  );
}

function RowSection({
  title,
  headingId,
  children,
}: {
  title: string;
  headingId: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionHeading}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Horizontal poster rail. Focusable and arrow-key scrollable so it can be driven
 * from the keyboard as well as by tabbing through the poster links inside it.
 */
function Scroller({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const el = event.currentTarget;
    const step = Math.max(el.clientWidth * SCROLL_STEP_FRACTION, 200);
    switch (event.key) {
      case 'ArrowRight':
        el.scrollBy?.({ left: step, behavior: 'smooth' });
        event.preventDefault();
        break;
      case 'ArrowLeft':
        el.scrollBy?.({ left: -step, behavior: 'smooth' });
        event.preventDefault();
        break;
      case 'Home':
        el.scrollTo?.({ left: 0, behavior: 'smooth' });
        event.preventDefault();
        break;
      case 'End':
        el.scrollTo?.({ left: el.scrollWidth, behavior: 'smooth' });
        event.preventDefault();
        break;
      default:
        break;
    }
  };

  return (
    <ul className={styles.scroller} aria-labelledby={labelledBy} tabIndex={0} onKeyDown={onKeyDown}>
      {children}
    </ul>
  );
}

function RowSkeleton({ title }: { title: string }) {
  return (
    <div
      className={styles.skeletonRow}
      role="status"
      aria-label={`Loading ${title}`}
      data-testid="row-skeleton"
    >
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <div key={index} className={styles.skeletonCard} aria-hidden="true">
          <div className={styles.skeletonPoster} />
          <div className={styles.skeletonLine} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder shown while the permitted-libraries query is still resolving. */
function HomeSkeleton() {
  return (
    <div className={styles.home}>
      {['Continue Watching', 'Recently Added'].map((title) => (
        <section key={title} className={styles.section}>
          <div className={styles.skeletonHeading} />
          <RowSkeleton title={title} />
        </section>
      ))}
    </div>
  );
}
