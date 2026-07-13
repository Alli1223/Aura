import { NavLink } from 'react-router';

import { useLibraries } from '../api/queries';
import { useAuth } from '../auth/context';
import {
  AdminIcon,
  CollectionsIcon,
  HistoryIcon,
  HomeIcon,
  LibraryIcon,
  PlaylistIcon,
} from './Icons';
import { Spinner } from './Spinner';
import styles from './Sidebar.module.css';

/** Left navigation: home + the user's permitted libraries. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const libraries = useLibraries();
  const { isAdmin } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.link} ${styles.linkActive}` : styles.link;

  return (
    <nav className={styles.nav} aria-label="Primary">
      <NavLink to="/" end className={linkClass} onClick={onNavigate}>
        <HomeIcon />
        <span>Home</span>
      </NavLink>

      <NavLink to="/collections" className={linkClass} onClick={onNavigate}>
        <CollectionsIcon />
        <span>Collections</span>
      </NavLink>

      <NavLink to="/history" className={linkClass} onClick={onNavigate}>
        <HistoryIcon />
        <span>History</span>
      </NavLink>

      <NavLink to="/playlists" className={linkClass} onClick={onNavigate}>
        <PlaylistIcon />
        <span>Playlists</span>
      </NavLink>

      <div className={styles.sectionLabel} id="libraries-heading">
        Libraries
      </div>

      <ul className={styles.list} aria-labelledby="libraries-heading">
        {libraries.isPending && (
          <li className={styles.stateRow}>
            <Spinner label="Loading libraries" />
          </li>
        )}

        {libraries.isError && (
          <li className={styles.stateRow}>
            <button type="button" className={styles.retry} onClick={() => void libraries.refetch()}>
              Couldn&apos;t load libraries. Retry
            </button>
          </li>
        )}

        {libraries.isSuccess && libraries.data.length === 0 && (
          <li className={styles.emptyRow}>No libraries yet</li>
        )}

        {libraries.isSuccess &&
          libraries.data.map((library) => (
            <li key={library.id}>
              <NavLink to={`/library/${library.id}`} className={linkClass} onClick={onNavigate}>
                <LibraryIcon type={library.type} />
                <span className={styles.libName}>{library.name}</span>
              </NavLink>
            </li>
          ))}
      </ul>

      {isAdmin && (
        <>
          <div className={styles.sectionLabel}>Manage</div>
          <NavLink to="/admin" className={linkClass} onClick={onNavigate}>
            <AdminIcon />
            <span>Admin</span>
          </NavLink>
        </>
      )}
    </nav>
  );
}
