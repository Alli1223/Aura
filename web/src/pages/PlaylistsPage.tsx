import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { artworkSrc } from '../api/media';
import { usePlaylists, useCreatePlaylist, type PlaylistSummary } from '../api/playlists';
import { AuthImage } from '../components/AuthImage';
import { ErrorState } from '../components/ErrorState';
import { PlaylistIcon, PlusIcon } from '../components/Icons';
import { Spinner } from '../components/Spinner';
import styles from './PlaylistsPage.module.css';

// The per-user playlists index (`/playlists`). Lists the caller's playlists (each
// links to its detail page) and offers an inline "New playlist" create form.
// Every playlist here is private to the caller — the server scopes the listing to
// the authenticated user.

function itemCountLabel(count: number): string {
  return count === 1 ? '1 item' : `${count} items`;
}

/** One playlist tile: poster (or a fallback) + name + accessible item count. */
function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  const poster = artworkSrc(playlist.posterUrl, 'w400');
  return (
    <li className={styles.cell}>
      <Link to={`/playlists/${playlist.id}`} className={styles.card} aria-label={playlist.name}>
        <div className={styles.poster}>
          {poster !== null ? (
            <AuthImage className={styles.image} src={poster} alt="" loading="lazy" />
          ) : (
            <div className={styles.fallback} aria-hidden="true">
              <PlaylistIcon width={32} height={32} />
            </div>
          )}
        </div>
        <div className={styles.caption}>
          <span className={styles.name}>{playlist.name}</span>
          <span className={styles.count}>{itemCountLabel(playlist.itemCount)}</span>
        </div>
      </Link>
    </li>
  );
}

/** Inline create form: type a name, submit to POST a new playlist. */
function CreatePlaylistForm() {
  const [name, setName] = useState('');
  const mutation = useCreatePlaylist();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || mutation.isPending) return;
    mutation.mutate(trimmed, { onSuccess: () => setName('') });
  };

  return (
    <form className={styles.createForm} onSubmit={onSubmit}>
      <input
        className={styles.input}
        type="text"
        value={name}
        maxLength={100}
        placeholder="New playlist name"
        aria-label="New playlist name"
        onChange={(event) => setName(event.target.value)}
      />
      <button
        type="submit"
        className="btn btn-primary"
        disabled={name.trim() === '' || mutation.isPending}
      >
        <PlusIcon width={18} height={18} />
        New playlist
      </button>
    </form>
  );
}

export function PlaylistsPage() {
  const playlists = usePlaylists();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Playlists</h1>
        <CreatePlaylistForm />
      </header>

      {playlists.isPending && (
        <div className={styles.stateBlock}>
          <Spinner label="Loading playlists" />
        </div>
      )}

      {playlists.isError && (
        <ErrorState
          title="Couldn't load playlists"
          message="Something went wrong fetching your playlists. Please try again."
          onRetry={() => void playlists.refetch()}
        />
      )}

      {playlists.isSuccess &&
        (playlists.data.length === 0 ? (
          <p className={styles.empty}>
            You have no playlists yet. Create one above, or add videos from an item's page.
          </p>
        ) : (
          <ul className={styles.grid}>
            {playlists.data.map((playlist) => (
              <PlaylistCard key={playlist.id} playlist={playlist} />
            ))}
          </ul>
        ))}
    </div>
  );
}
