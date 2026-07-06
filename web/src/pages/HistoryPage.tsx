import { useState } from 'react';
import { Link } from 'react-router';

import { artworkSrc, type MediaItem } from '../api/media';
import {
  HISTORY_PAGE_SIZE,
  useDeleteHistoryItem,
  useHistory,
  type HistoryEntry,
} from '../api/history';
import { AuthImage } from '../components/AuthImage';
import { ErrorState } from '../components/ErrorState';
import { EmptyState, Page, PageHeader } from '../components/Page';
import { Spinner } from '../components/Spinner';
import styles from './HistoryPage.module.css';

// Per-user watch history: a paginated list of the items the caller has watched
// or started, most-recent activity first, each with a progress/watched status,
// its last-watched time and a "remove from history" action.

/** Absolute date + time for a history row's last activity. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "S1E3"-style episode code, omitting whichever number is unknown. */
function episodeCode(item: MediaItem): string {
  const season = item.seasonNumber !== null ? `S${item.seasonNumber}` : '';
  const episode = item.episodeNumber !== null ? `E${item.episodeNumber}` : '';
  return `${season}${episode}`;
}

/** The primary (linked) and secondary lines for an entry. */
function entryLabels(entry: HistoryEntry): { primary: string; secondary: string | null } {
  const { item, showTitle } = entry;
  if (item.type === 'episode') {
    const code = episodeCode(item);
    const suffix = [code, item.title].filter((part) => part !== '').join(' · ');
    return { primary: showTitle ?? item.title, secondary: suffix === '' ? null : suffix };
  }
  return { primary: item.title, secondary: item.year !== null ? String(item.year) : null };
}

export function HistoryPage() {
  const [page, setPage] = useState(1);
  const query = useHistory(page);
  const remove = useDeleteHistoryItem();

  return (
    <Page>
      <PageHeader
        title="Watch History"
        subtitle="Everything you've watched or started, most recent first."
      />
      <HistoryBody
        query={query}
        page={page}
        onPageChange={setPage}
        onRemove={(itemId) => remove.mutate(itemId)}
        removingId={remove.isPending ? remove.variables : undefined}
      />
    </Page>
  );
}

interface HistoryBodyProps {
  query: ReturnType<typeof useHistory>;
  page: number;
  onPageChange: (page: number) => void;
  onRemove: (itemId: string) => void;
  removingId: string | undefined;
}

function HistoryBody({ query, page, onPageChange, onRemove, removingId }: HistoryBodyProps) {
  if (query.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading history" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load your history"
        message="Something went wrong fetching your watch history. Please try again."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const { items, total, pageSize } = query.data;
  if (total === 0) {
    return (
      <EmptyState
        title="Nothing watched yet"
        message="Items you play or mark watched will show up here."
      />
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / (pageSize || HISTORY_PAGE_SIZE)));

  return (
    <div className={styles.history}>
      <ul className={styles.list}>
        {items.map((entry) => (
          <HistoryRow
            key={entry.item.id}
            entry={entry}
            onRemove={onRemove}
            removing={removingId === entry.item.id}
          />
        ))}
      </ul>

      {totalPages > 1 && (
        <nav className={styles.pager} aria-label="History pages">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || query.isFetching}
          >
            Previous
          </button>
          <span className={styles.pageInfo}>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages || query.isFetching}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  onRemove,
  removing,
}: {
  entry: HistoryEntry;
  onRemove: (itemId: string) => void;
  removing: boolean;
}) {
  const { item, watchState } = entry;
  const { primary, secondary } = entryLabels(entry);
  const src = artworkSrc(item.posterUrl, 'w200');
  const fraction =
    item.runtimeMs !== null && item.runtimeMs > 0
      ? Math.min(watchState.positionMs / item.runtimeMs, 1)
      : 0;
  const inProgress = !watchState.watched && watchState.positionMs > 0;
  const progressPercent = Math.round(fraction * 100);

  return (
    <li className={styles.row}>
      <Link to={`/items/${item.id}`} className={styles.link}>
        <div className={styles.thumb}>
          {src === null ? (
            <span className={styles.thumbFallback} aria-hidden="true">
              {primary}
            </span>
          ) : (
            <AuthImage className={styles.thumbImage} src={src} alt="" />
          )}
        </div>
        <div className={styles.meta}>
          <span className={styles.title}>{primary}</span>
          {secondary !== null && <span className={styles.sub}>{secondary}</span>}
          {watchState.watched ? (
            <span className={styles.watched}>Watched</span>
          ) : inProgress ? (
            <span
              className={styles.progressTrack}
              role="progressbar"
              aria-label="Watch progress"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
            </span>
          ) : null}
        </div>
      </Link>

      <div className={styles.aside}>
        <time className={styles.time} dateTime={watchState.lastActivity}>
          {formatWhen(watchState.lastActivity)}
        </time>
        <button
          type="button"
          className={`btn btn-ghost ${styles.removeBtn}`}
          aria-label={`Remove ${primary} from history`}
          onClick={() => onRemove(item.id)}
          disabled={removing}
        >
          {removing ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </li>
  );
}
