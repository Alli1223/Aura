import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { ApiError } from '../api/client';
import { artworkSrc } from '../api/media';
import {
  usePlaylist,
  useRenamePlaylist,
  useDeletePlaylist,
  useRemovePlaylistItem,
  useReorderPlaylist,
  type PlaylistItem,
} from '../api/playlists';
import { AuthImage } from '../components/AuthImage';
import { ErrorState } from '../components/ErrorState';
import { PlaylistIcon, TrashIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import styles from './PlaylistDetailPage.module.css';

// A single playlist's detail (`/playlists/:id`): its ordered items with per-item
// play, remove and move-up/down reorder, plus a "Play all" button, rename and
// delete. Continuous playback: every play link carries the playlist queue
// context (`?item=&playlist=&index=`) so the player advances through the
// remaining items when one finishes (see PlayerPage's usePlaylistQueue).

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

/** The player link for a playable item, carrying the playlist queue context. */
function playerHref(playlistId: string, item: PlaylistItem, index: number): string | null {
  if (!item.hasFile || item.primaryMediaFileId === null) return null;
  const query = new URLSearchParams({
    item: item.id,
    playlist: playlistId,
    index: String(index),
  });
  return `/player/${encodeURIComponent(item.primaryMediaFileId)}?${query.toString()}`;
}

function subtitle(item: PlaylistItem): string {
  if (item.type === 'episode') {
    const s = item.seasonNumber;
    const e = item.episodeNumber;
    if (s !== null && e !== null) return `S${s} · E${e}`;
  }
  return item.year !== null ? String(item.year) : '';
}

/** One playlist row: thumbnail, title, play, reorder and remove controls. */
function ItemRow({
  playlistId,
  item,
  index,
  count,
  onMove,
  onRemove,
  busy,
}: {
  playlistId: string;
  item: PlaylistItem;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  onRemove: (mediaItemId: string) => void;
  busy: boolean;
}) {
  const thumb = artworkSrc(item.posterUrl ?? item.backdropUrl, 'w200');
  const href = playerHref(playlistId, item, index);

  return (
    <li className={styles.row}>
      <span className={styles.position} aria-hidden="true">
        {index + 1}
      </span>
      <Link to={`/items/${item.id}`} className={styles.thumb} aria-label={item.title}>
        {thumb !== null ? (
          <AuthImage className={styles.thumbImage} src={thumb} alt="" />
        ) : (
          <span className={styles.thumbFallback}>{item.title}</span>
        )}
      </Link>

      <div className={styles.meta}>
        <Link to={`/items/${item.id}`} className={styles.itemTitle}>
          {item.title}
        </Link>
        {subtitle(item) !== '' && <span className={styles.sub}>{subtitle(item)}</span>}
      </div>

      <div className={styles.rowActions}>
        {href !== null ? (
          <Link to={href} className={`btn btn-primary ${styles.iconBtn}`} aria-label={`Play ${item.title}`}>
            <PlayIcon />
          </Link>
        ) : (
          <span className={`btn ${styles.iconBtn} ${styles.disabled}`} aria-disabled="true">
            Unavailable
          </span>
        )}
        <button
          type="button"
          className={`btn btn-ghost ${styles.iconBtn}`}
          aria-label={`Move ${item.title} up`}
          disabled={busy || index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className={`btn btn-ghost ${styles.iconBtn}`}
          aria-label={`Move ${item.title} down`}
          disabled={busy || index === count - 1}
          onClick={() => onMove(index, index + 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className={`btn btn-ghost ${styles.iconBtn}`}
          aria-label={`Remove ${item.title}`}
          disabled={busy}
          onClick={() => onRemove(item.id)}
        >
          <TrashIcon width={16} height={16} />
        </button>
      </div>
    </li>
  );
}

/** Inline rename control: a "Rename" button that swaps to an input on edit. */
function RenameControl({ playlistId, name }: { playlistId: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const mutation = useRenamePlaylist(playlistId);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === name) {
      setEditing(false);
      return;
    }
    mutation.mutate(trimmed, { onSuccess: () => setEditing(false) });
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
      >
        Rename
      </button>
    );
  }

  return (
    <form className={styles.renameForm} onSubmit={onSubmit}>
      <input
        className={styles.input}
        type="text"
        value={value}
        maxLength={100}
        aria-label="Playlist name"
        autoFocus
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
        Save
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

function PlaylistDetail({ playlistId }: { playlistId: string }) {
  const navigate = useNavigate();
  const query = usePlaylist(playlistId);
  const reorderMutation = useReorderPlaylist(playlistId);
  const removeMutation = useRemovePlaylistItem(playlistId);
  const deleteMutation = useDeletePlaylist();

  if (query.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading playlist" />
      </div>
    );
  }

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    if (notFound) {
      return (
        <ErrorState
          title="Playlist not found"
          message="This playlist doesn't exist, or it isn't yours."
        />
      );
    }
    return (
      <ErrorState
        title="Couldn't load this playlist"
        message="Something went wrong. Please try again."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const playlist = query.data;
  const items = playlist.items;
  const firstPlayableIndex = items.findIndex((item) => item.hasFile);
  const playAllHref =
    firstPlayableIndex >= 0
      ? playerHref(playlistId, items[firstPlayableIndex]!, firstPlayableIndex)
      : null;

  const busy = reorderMutation.isPending || removeMutation.isPending;

  const onMove = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const ids = items.map((item) => item.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    reorderMutation.mutate(ids);
  };

  const onDelete = () => {
    deleteMutation.mutate(playlistId, { onSuccess: () => navigate('/playlists') });
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headline}>
          <h1 className={styles.title}>{playlist.name}</h1>
          <span className={styles.count}>
            {items.length === 1 ? '1 item' : `${items.length} items`}
          </span>
        </div>
        <div className={styles.headerActions}>
          {playAllHref !== null && (
            <Link to={playAllHref} className="btn btn-primary">
              <PlayIcon />
              Play all
            </Link>
          )}
          <RenameControl playlistId={playlistId} name={playlist.name} />
          <button
            type="button"
            className="btn btn-ghost"
            disabled={deleteMutation.isPending}
            onClick={onDelete}
          >
            <TrashIcon width={16} height={16} />
            Delete
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <div className={styles.empty}>
          <PlaylistIcon width={40} height={40} />
          <p>This playlist is empty. Add videos from an item's page.</p>
        </div>
      ) : (
        <ul className={styles.list}>
          {items.map((item, index) => (
            <ItemRow
              key={item.id}
              playlistId={playlistId}
              item={item}
              index={index}
              count={items.length}
              onMove={onMove}
              onRemove={(mediaItemId) => removeMutation.mutate(mediaItemId)}
              busy={busy}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Route entry for `/playlists/:id`. Keyed on the id so a nav fully remounts. */
export function PlaylistDetailPage() {
  const { id = '' } = useParams();
  return <PlaylistDetail key={id} playlistId={id} />;
}
