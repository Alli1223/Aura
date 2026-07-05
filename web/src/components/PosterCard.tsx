import { useState } from 'react';
import { Link } from 'react-router';

import { artworkSrc, type ArtworkSize, type MediaItem } from '../api/media';
import { AuthImage } from './AuthImage';
import { CheckIcon } from './Icons';
import styles from './PosterCard.module.css';

// Reusable poster tile shared across browse, media-detail and the home screen.
// Renders a lazy-loaded poster (with a graceful title fallback for a missing or
// broken image), a title/year caption, and a watch-state overlay (a watched
// checkmark or an in-progress bar). The whole tile links to the item's detail
// route (`/items/:id`) — that route is added by the media-detail feature; the
// link is valid to render before then.

export interface PosterCardProps {
  item: MediaItem;
  /** Poster size bucket to request (default w400). */
  size?: ArtworkSize;
  /** Native `<img>` loading strategy (default 'lazy'). */
  loading?: 'lazy' | 'eager';
  /**
   * Optional query string (no leading `?`) appended to the detail link, e.g.
   * `show=abc` so a season card carries its parent-show context for breadcrumbs.
   */
  search?: string;
}

/** Watch-state → visual overlay: whether it's fully watched and the fraction done. */
function watchProgress(item: MediaItem): { watched: boolean; fraction: number } {
  const state = item.watchState;
  // Containers (show/season) report episode counts; use those for the fraction.
  if (state.episodeCount > 0) {
    return {
      watched: state.watched,
      fraction: state.watchedEpisodeCount / state.episodeCount,
    };
  }
  if (state.watched) return { watched: true, fraction: 1 };
  // Leaf in progress: a resume position against a known runtime.
  if (item.runtimeMs !== null && item.runtimeMs > 0 && state.positionMs > 0) {
    return { watched: false, fraction: Math.min(state.positionMs / item.runtimeMs, 1) };
  }
  return { watched: false, fraction: 0 };
}

/** Year suffix for the caption/label, empty when the year is unknown. */
function yearLabel(year: number | null): string {
  return year === null ? '' : ` (${year})`;
}

export function PosterCard({ item, size = 'w400', loading = 'lazy', search }: PosterCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const src = artworkSrc(item.posterUrl, size);
  const showFallback = src === null || imageFailed;

  const { watched, fraction } = watchProgress(item);
  const inProgress = !watched && fraction > 0;
  const progressPercent = Math.round(fraction * 100);
  const label = `${item.title}${yearLabel(item.year)}`;
  const to =
    search !== undefined && search !== '' ? `/items/${item.id}?${search}` : `/items/${item.id}`;

  return (
    <Link to={to} className={styles.card} aria-label={label}>
      <div className={styles.poster}>
        {showFallback ? (
          <div className={styles.fallback} aria-hidden="true">
            <span className={styles.fallbackTitle}>{item.title}</span>
          </div>
        ) : (
          <AuthImage
            className={styles.image}
            src={src}
            alt={item.title}
            loading={loading}
            onError={() => setImageFailed(true)}
          />
        )}

        {watched && (
          <span className={styles.watchedBadge} title="Watched">
            <CheckIcon />
          </span>
        )}

        {inProgress && (
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
        )}
      </div>

      <div className={styles.caption}>
        <span className={styles.title}>{item.title}</span>
        {item.year !== null && <span className={styles.year}>{item.year}</span>}
      </div>
    </Link>
  );
}
