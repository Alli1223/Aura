import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { ApiError } from '../api/client';
import {
  useItemDetail,
  useSetWatched,
  type DetailEpisode,
  type ItemDetail,
  type MediaFileInfo,
} from '../api/detail';
import { artworkSrc, type MediaItem } from '../api/media';
import { AuthImage } from '../components/AuthImage';
import { CheckIcon } from '../components/Icons';
import { ErrorState } from '../components/ErrorState';
import { PosterCard } from '../components/PosterCard';
import styles from './ItemDetailPage.module.css';

// Movie detail + show → seasons → episodes navigation. A single useItemDetail
// call resolves the item's type and its type-specific sub-collection (a movie's
// files, a show's seasons, or a season's episodes), then the view branches on
// item.type. Play/Resume buttons target the video player at
// `/player/:mediaFileId?item=:itemId`; the player lands with the video-player
// feature. Artwork always goes through AuthImage (the artwork route needs a
// bearer token a raw <img> cannot send).

/** The player link contract emitted for every Play/Resume button. */
function playerHref(mediaFileId: string, itemId: string): string {
  return `/player/${encodeURIComponent(mediaFileId)}?item=${encodeURIComponent(itemId)}`;
}

/** A playable episode descriptor the player autoplays next, in season order. */
interface PlayDescriptor {
  mediaFileId: string;
  itemId: string;
  title: string;
}

/** The descriptor for a playable episode, or null when it has no file. */
function episodeDescriptor(episode: DetailEpisode | undefined): PlayDescriptor | null {
  if (episode === undefined || !episode.hasFile || episode.primaryMediaFileId === null) return null;
  return { mediaFileId: episode.primaryMediaFileId, itemId: episode.id, title: episode.title };
}

/** The queue of playable episodes AFTER `fromIndex`, for next-episode autoplay. */
function nextEpisodeQueue(episodes: DetailEpisode[], fromIndex: number): PlayDescriptor[] {
  const queue: PlayDescriptor[] = [];
  for (let i = fromIndex + 1; i < episodes.length; i += 1) {
    const descriptor = episodeDescriptor(episodes[i]);
    if (descriptor !== null) queue.push(descriptor);
  }
  return queue;
}

// ---- Formatting helpers -----------------------------------------------------

function formatRuntime(ms: number | null): string | null {
  if (ms === null || ms <= 0) return null;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatRating(rating: number | null): string | null {
  return rating === null ? null : rating.toFixed(1);
}

function resolutionLabel(width: number | null, height: number | null): string | null {
  if (height === null) return width === null ? null : `${width}px`;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  return `${height}p`;
}

function formatSize(bytes: number): string | null {
  if (bytes <= 0) return null;
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function channelLabel(channels: number | null): string | null {
  if (channels === null) return null;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

/** Joins the defined, non-empty parts of a label with a middle dot. */
function joinParts(parts: (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(' · ');
}

function versionLabel(file: MediaFileInfo, index: number): string {
  const label = joinParts([
    resolutionLabel(file.width, file.height),
    file.container?.toUpperCase() ?? null,
    file.videoCodec?.toUpperCase() ?? null,
  ]);
  return label === '' ? `Version ${index + 1}` : label;
}

// ---- Shared building blocks -------------------------------------------------

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

/** Optimistic watched toggle button, wired to the mark-watched mutation. */
function WatchedButton({
  itemId,
  watched,
  watchedText,
  unwatchedText,
  ariaLabel,
  className = 'btn btn-ghost',
}: {
  itemId: string;
  watched: boolean;
  watchedText: string;
  unwatchedText: string;
  ariaLabel?: string;
  className?: string;
}) {
  const mutation = useSetWatched(itemId);
  return (
    <button
      type="button"
      className={className}
      aria-pressed={watched}
      aria-label={ariaLabel}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!watched)}
    >
      <CheckIcon />
      {watched ? watchedText : unwatchedText}
    </button>
  );
}

function GenreList({ genres }: { genres: string[] }) {
  if (genres.length === 0) return null;
  return (
    <ul className={styles.genres} aria-label="Genres">
      {genres.map((genre) => (
        <li key={genre} className={styles.genre}>
          {genre}
        </li>
      ))}
    </ul>
  );
}

/** Year · runtime · rating · content-rating summary line. */
function MetaRow({ item }: { item: MediaItem }) {
  const runtime = formatRuntime(item.runtimeMs);
  const rating = formatRating(item.communityRating);
  const hasAny =
    item.year !== null || runtime !== null || rating !== null || item.contentRating !== null;
  if (!hasAny) return null;

  return (
    <div className={styles.metaRow}>
      {item.year !== null && <span className={styles.metaItem}>{item.year}</span>}
      {runtime !== null && <span className={styles.metaItem}>{runtime}</span>}
      {rating !== null && (
        <span className={styles.metaItem}>
          <span className={styles.rating}>★ {rating}</span>
        </span>
      )}
      {item.contentRating !== null && (
        <span className={styles.contentRating}>{item.contentRating}</span>
      )}
    </div>
  );
}

/** Backdrop hero with poster and a body slot for title/metadata/actions. */
function Hero({ item, children }: { item: MediaItem; children: ReactNode }) {
  const backdrop = artworkSrc(item.backdropUrl, 'w800');
  const poster = artworkSrc(item.posterUrl, 'w400');
  return (
    <section className={styles.hero}>
      {backdrop !== null && (
        <div className={styles.heroBackdrop} aria-hidden="true">
          <AuthImage src={backdrop} alt="" loading="eager" />
        </div>
      )}
      <div className={styles.heroScrim} aria-hidden="true" />
      <div className={styles.heroInner}>
        <div className={styles.posterFrame}>
          {poster !== null ? (
            <AuthImage src={poster} alt={`${item.title} poster`} loading="eager" />
          ) : (
            <div className={styles.posterFallback}>{item.title}</div>
          )}
        </div>
        <div className={styles.heroBody}>{children}</div>
      </div>
    </section>
  );
}

// ---- Movie / leaf detail ----------------------------------------------------

/** A resume progress bar for a leaf that has a stored position. */
function ResumeMeta({ positionMs, durationMs }: { positionMs: number; durationMs: number | null }) {
  const percent =
    durationMs !== null && durationMs > 0
      ? Math.min(100, Math.round((positionMs / durationMs) * 100))
      : 0;
  return (
    <div className={styles.resumeMeta}>
      <span
        className={styles.resumeTrack}
        role="progressbar"
        aria-label="Resume position"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className={styles.resumeFill} style={{ width: `${percent}%` }} />
      </span>
      <span>{percent}% watched</span>
    </div>
  );
}

function StreamGroup({
  title,
  streams,
}: {
  title: string;
  streams: { key: string; label: string; badge?: string | null }[];
}) {
  if (streams.length === 0) return null;
  return (
    <div className={styles.streamGroup}>
      <span className={styles.panelKey}>{title}</span>
      <ul className={styles.streamList}>
        {streams.map((stream) => (
          <li key={stream.key} className={styles.streamItem}>
            {stream.label}
            {stream.badge != null && <span className={styles.streamBadge}>{stream.badge}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Container/resolution/codec + per-track audio & subtitle info for one file. */
function TechnicalPanel({ file }: { file: MediaFileInfo }) {
  const cells: { key: string; value: string }[] = [];
  const resolution = resolutionLabel(file.width, file.height);
  if (resolution !== null) cells.push({ key: 'Resolution', value: resolution });
  if (file.width !== null && file.height !== null) {
    cells.push({ key: 'Dimensions', value: `${file.width} × ${file.height}` });
  }
  if (file.container !== null)
    cells.push({ key: 'Container', value: file.container.toUpperCase() });
  if (file.videoCodec !== null) cells.push({ key: 'Video', value: file.videoCodec.toUpperCase() });
  if (file.bitrate !== null && file.bitrate > 0) {
    cells.push({ key: 'Bitrate', value: `${Math.round(file.bitrate / 1_000_000)} Mbps` });
  }
  const size = formatSize(file.size);
  if (size !== null) cells.push({ key: 'Size', value: size });

  const audio = file.audioStreams.map((stream) => ({
    key: `a-${stream.index}`,
    label: joinParts([
      stream.language ?? 'Undetermined',
      stream.codec?.toUpperCase() ?? null,
      channelLabel(stream.channels),
      stream.title ?? null,
    ]),
    badge: stream.default ? 'Default' : null,
  }));
  const subtitles = file.subtitleStreams.map((stream) => ({
    key: `s-${stream.index}`,
    label: joinParts([
      stream.language ?? 'Undetermined',
      stream.codec?.toUpperCase() ?? null,
      stream.title ?? null,
    ]),
    badge: stream.forced ? 'Forced' : null,
  }));

  return (
    <section className={styles.section} aria-label="File & stream information">
      <h2 className={styles.sectionTitle}>Media info</h2>
      <div className={styles.panel}>
        <div className={styles.panelGrid}>
          {cells.map((cell) => (
            <div key={cell.key} className={styles.panelCell}>
              <span className={styles.panelKey}>{cell.key}</span>
              <span className={styles.panelValue}>{cell.value}</span>
            </div>
          ))}
        </div>
        <StreamGroup title="Audio" streams={audio} />
        <StreamGroup title="Subtitles" streams={subtitles} />
      </div>
    </section>
  );
}

/** Movie (and directly-visited episode) detail: hero, play/resume, media info. */
function LeafDetail({ detail }: { detail: ItemDetail }) {
  const { item, files } = detail;
  const [selectedFileId, setSelectedFileId] = useState(files[0]?.id ?? '');
  const selectedFile = files.find((file) => file.id === selectedFileId) ?? files[0] ?? null;

  const { watched, positionMs } = item.watchState;
  const canResume = !watched && positionMs > 0;
  const resumeDuration = item.runtimeMs ?? selectedFile?.durationMs ?? null;

  return (
    <div className={styles.page}>
      <Hero item={item}>
        <h1 className={styles.title}>{item.title}</h1>
        {item.tagline !== null && item.tagline !== '' && (
          <p className={styles.tagline}>{item.tagline}</p>
        )}
        <MetaRow item={item} />
        <GenreList genres={item.genres} />

        <div className={styles.actions}>
          {selectedFile !== null ? (
            <Link
              to={playerHref(selectedFile.id, item.id)}
              className={`btn btn-primary ${styles.playButton}`}
            >
              <PlayIcon />
              {canResume ? 'Resume' : 'Play'}
            </Link>
          ) : (
            <span
              className={`btn ${styles.playButton} ${styles.disabledPlay}`}
              aria-disabled="true"
            >
              <PlayIcon />
              No playable file
            </span>
          )}

          {files.length > 1 && (
            <label className={styles.versionPicker}>
              <span className={styles.versionLabel}>Version</span>
              <select
                className={styles.select}
                value={selectedFileId}
                onChange={(event) => setSelectedFileId(event.target.value)}
              >
                {files.map((file, index) => (
                  <option key={file.id} value={file.id}>
                    {versionLabel(file, index)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <WatchedButton
            itemId={item.id}
            watched={watched}
            watchedText="Mark unwatched"
            unwatchedText="Mark watched"
          />
        </div>

        {canResume && <ResumeMeta positionMs={positionMs} durationMs={resumeDuration} />}
      </Hero>

      {item.overview !== null && item.overview !== '' && (
        <p className={styles.overview}>{item.overview}</p>
      )}

      {selectedFile !== null && <TechnicalPanel file={selectedFile} />}
    </div>
  );
}

// ---- Show detail ------------------------------------------------------------

/** A season tile (reused PosterCard) with an episode-count caption. */
function SeasonCell({ season, showId }: { season: MediaItem; showId: string }) {
  const { episodeCount, watchedEpisodeCount } = season.watchState;
  return (
    <li className={styles.seasonCell}>
      <PosterCard item={season} search={`show=${showId}`} />
      {episodeCount > 0 && (
        <span className={styles.seasonCount}>
          {watchedEpisodeCount}/{episodeCount} watched
        </span>
      )}
    </li>
  );
}

function ShowDetail({ detail }: { detail: ItemDetail }) {
  const { item, seasons } = detail;
  return (
    <div className={styles.page}>
      <Hero item={item}>
        <h1 className={styles.title}>{item.title}</h1>
        {item.tagline !== null && item.tagline !== '' && (
          <p className={styles.tagline}>{item.tagline}</p>
        )}
        <MetaRow item={item} />
        <GenreList genres={item.genres} />
        {item.overview !== null && item.overview !== '' && (
          <p className={styles.overview}>{item.overview}</p>
        )}
      </Hero>

      <section className={styles.section} aria-label="Seasons">
        <h2 className={styles.sectionTitle}>Seasons</h2>
        {seasons.length === 0 ? (
          <p className={styles.overview}>No seasons have been added yet.</p>
        ) : (
          <ul className={styles.seasonsGrid}>
            {seasons.map((season) => (
              <SeasonCell key={season.id} season={season} showId={item.id} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---- Season detail ----------------------------------------------------------

/** One episode row: thumbnail, title/overview, play target and watched toggle. */
function EpisodeRow({
  episode,
  nextQueue,
}: {
  episode: DetailEpisode;
  nextQueue: PlayDescriptor[];
}) {
  const thumb = artworkSrc(episode.posterUrl ?? episode.backdropUrl, 'w400');
  const { watched, positionMs } = episode.watchState;
  const percent =
    !watched && episode.runtimeMs !== null && episode.runtimeMs > 0 && positionMs > 0
      ? Math.min(100, Math.round((positionMs / episode.runtimeMs) * 100))
      : 0;
  const canResume = percent > 0;
  const numberLabel =
    episode.episodeNumber !== null
      ? `E${episode.episodeNumber}`
      : episode.absoluteEpisodeNumber !== null
        ? `#${episode.absoluteEpisodeNumber}`
        : '';

  return (
    <li className={styles.episode}>
      <div className={styles.episodeThumb}>
        {thumb !== null ? (
          <AuthImage src={thumb} alt={`${episode.title} thumbnail`} />
        ) : (
          <div className={styles.episodeThumbFallback}>{numberLabel || episode.title}</div>
        )}
        {canResume && (
          <span
            className={styles.episodeProgress}
            role="progressbar"
            aria-label={`Watch progress: ${episode.title}`}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className={styles.episodeProgressFill} style={{ width: `${percent}%` }} />
          </span>
        )}
      </div>

      <div className={styles.episodeBody}>
        <div className={styles.episodeHead}>
          {numberLabel !== '' && <span className={styles.episodeNumber}>{numberLabel}</span>}
          <span className={styles.episodeTitle}>{episode.title}</span>
          {watched && (
            <span className={styles.episodeWatchedMark} title="Watched">
              <CheckIcon />
            </span>
          )}
        </div>

        {episode.overview !== null && episode.overview !== '' && (
          <p className={styles.episodeOverview}>{episode.overview}</p>
        )}

        <div className={styles.episodeActions}>
          {episode.hasFile && episode.primaryMediaFileId !== null ? (
            <Link
              to={playerHref(episode.primaryMediaFileId, episode.id)}
              state={{ queue: nextQueue }}
              className={`btn btn-primary ${styles.iconButton}`}
            >
              <PlayIcon />
              {canResume ? 'Resume' : 'Play'}
            </Link>
          ) : (
            <span
              className={`btn ${styles.iconButton} ${styles.disabledPlay}`}
              aria-disabled="true"
            >
              Unavailable
            </span>
          )}

          <WatchedButton
            itemId={episode.id}
            watched={watched}
            watchedText="Mark unwatched"
            unwatchedText="Mark watched"
            ariaLabel={`${watched ? 'Mark unwatched' : 'Mark watched'}: ${episode.title}`}
            className={`btn btn-ghost ${styles.iconButton}`}
          />
        </div>
      </div>
    </li>
  );
}

function Breadcrumb({ showId }: { showId: string | null }) {
  // The season detail (server SerializedItem) has no parent link, so the parent
  // show comes from the `?show=` query set when navigating from the show page.
  // Fetched (cache-first) only to resolve the show's title for the crumb.
  const showQuery = useItemDetail(showId ?? '', { enabled: showId !== null && showId !== '' });
  if (showId === null || showId === '') return null;
  const title = showQuery.data?.item.title ?? 'Show';
  return (
    <nav className={styles.breadcrumb} aria-label="Breadcrumb">
      <Link to={`/items/${showId}`} className={styles.crumbLink}>
        {title}
      </Link>
    </nav>
  );
}

function SeasonDetail({ detail }: { detail: ItemDetail }) {
  const { item, episodes } = detail;
  const [searchParams] = useSearchParams();
  const showId = searchParams.get('show');

  const seasonNumber = item.seasonNumber ?? episodes[0]?.seasonNumber ?? null;
  const heading = seasonNumber !== null ? `Season ${seasonNumber}` : item.title;
  const allWatched = episodes.length > 0 && episodes.every((episode) => episode.watchState.watched);

  return (
    <div className={styles.page}>
      <Breadcrumb showId={showId} />

      <header className={styles.section}>
        <h1 className={styles.title}>{heading}</h1>
        <div className={styles.actions}>
          <WatchedButton
            itemId={item.id}
            watched={allWatched}
            watchedText="Mark season unwatched"
            unwatchedText="Mark season watched"
          />
        </div>
      </header>

      <section className={styles.section} aria-label="Episodes">
        <h2 className={styles.sectionTitle}>Episodes</h2>
        {episodes.length === 0 ? (
          <p className={styles.overview}>No episodes have been added to this season yet.</p>
        ) : (
          <ul className={styles.episodeList}>
            {episodes.map((episode, index) => (
              <EpisodeRow
                key={episode.id}
                episode={episode}
                nextQueue={nextEpisodeQueue(episodes, index)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---- States -----------------------------------------------------------------

function DetailSkeleton() {
  return (
    <div className={styles.page} role="status" aria-label="Loading">
      <div className={styles.skeletonHero} data-testid="detail-skeleton" />
      <div className={styles.skeletonLine} style={{ width: '40%' }} />
      <div className={styles.skeletonLine} style={{ width: '70%' }} />
      <div className={styles.skeletonLine} style={{ width: '55%' }} />
    </div>
  );
}

// ---- Route entry ------------------------------------------------------------

/** Route entry for `/items/:id`. Keyed on the id so a nav fully remounts. */
export function ItemDetailPage() {
  const { id = '' } = useParams();
  return <ItemDetail key={id} itemId={id} />;
}

function ItemDetail({ itemId }: { itemId: string }) {
  const query = useItemDetail(itemId);

  if (query.isPending) {
    return <DetailSkeleton />;
  }

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    if (notFound) {
      return (
        <div className={styles.page}>
          <ErrorState
            title="Not found"
            message="This item doesn't exist, or you don't have access to it."
          />
        </div>
      );
    }
    return (
      <div className={styles.page}>
        <ErrorState
          title="Couldn't load this item"
          message="Something went wrong while fetching the details. Please try again."
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const detail = query.data;
  if (detail.item.type === 'show') return <ShowDetail detail={detail} />;
  if (detail.item.type === 'season') return <SeasonDetail detail={detail} />;
  return <LeafDetail detail={detail} />;
}
