import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import {
  usePlaylists,
  useAddPlaylistItem,
  useCreatePlaylist,
  type PlaylistSummary,
} from '../api/playlists';
import { PlaylistIcon, PlusIcon } from './Icons';
import { Spinner } from './Spinner';
import styles from './AddToPlaylistMenu.module.css';

// A small dropdown that adds the given media item to one of the caller's
// playlists, or to a brand-new one. Used on the item detail page. Playlists are
// loaded lazily (only when the menu opens) and every mutation reconciles the
// playlist listing via the query invalidation in api/playlists.ts.

export function AddToPlaylistMenu({ mediaItemId }: { mediaItemId: string }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const playlists = usePlaylists({ enabled: open });
  const addMutation = useAddPlaylistItem();
  const createMutation = useCreatePlaylist();

  const closeMenu = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setNewName('');
  }, []);

  // Close on an outside click while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, closeMenu]);

  const addToExisting = (playlist: PlaylistSummary) => {
    addMutation.mutate(
      { playlistId: playlist.id, mediaItemId },
      {
        onSuccess: (result) => {
          setFeedback(result.added ? `Added to ${playlist.name}` : `Already in ${playlist.name}`);
          closeMenu();
        },
      },
    );
  };

  const onCreateSubmit = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (name === '' || createMutation.isPending) return;
    createMutation.mutate(name, {
      onSuccess: (playlist) => {
        addMutation.mutate(
          { playlistId: playlist.id, mediaItemId },
          {
            onSuccess: () => {
              setFeedback(`Added to ${playlist.name}`);
              closeMenu();
            },
          },
        );
      },
    });
  };

  return (
    <div className={styles.wrap} ref={containerRef}>
      <button
        type="button"
        className="btn btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setFeedback(null);
          setOpen((value) => !value);
        }}
      >
        <PlaylistIcon width={18} height={18} />
        Add to playlist
      </button>

      {feedback !== null && !open && (
        <span className={styles.feedback} role="status">
          {feedback}
        </span>
      )}

      {open && (
        <div className={styles.menu} role="menu" aria-label="Add to playlist">
          {playlists.isPending && (
            <div className={styles.menuState}>
              <Spinner label="Loading playlists" />
            </div>
          )}

          {playlists.isError && (
            <div className={styles.menuState}>Couldn't load playlists.</div>
          )}

          {playlists.isSuccess && playlists.data.length > 0 && (
            <ul className={styles.list}>
              {playlists.data.map((playlist) => (
                <li key={playlist.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    disabled={addMutation.isPending}
                    onClick={() => addToExisting(playlist)}
                  >
                    <span className={styles.itemName}>{playlist.name}</span>
                    <span className={styles.itemCount}>{playlist.itemCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {playlists.isSuccess && playlists.data.length === 0 && !creating && (
            <p className={styles.emptyHint}>No playlists yet.</p>
          )}

          {creating ? (
            <form className={styles.createForm} onSubmit={onCreateSubmit}>
              <input
                className={styles.input}
                type="text"
                value={newName}
                maxLength={100}
                placeholder="Playlist name"
                aria-label="New playlist name"
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
              />
              <button
                type="submit"
                className={`btn btn-primary ${styles.createBtn}`}
                disabled={newName.trim() === '' || createMutation.isPending || addMutation.isPending}
              >
                Create
              </button>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={`${styles.menuItem} ${styles.newItem}`}
              onClick={() => setCreating(true)}
            >
              <PlusIcon width={16} height={16} />
              New playlist
            </button>
          )}
        </div>
      )}
    </div>
  );
}
