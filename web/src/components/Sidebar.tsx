import { NavLink } from 'react-router';

import { useLibraries } from '../api/queries';
import { HomeIcon, LibraryIcon } from './Icons';
import { Spinner } from './Spinner';
import styles from './Sidebar.module.css';

/** Left navigation: home + the user's permitted libraries. */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const libraries = useLibraries();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.link} ${styles.linkActive}` : styles.link;

  return (
    <nav className={styles.nav} aria-label="Primary">
      <NavLink to="/" end className={linkClass} onClick={onNavigate}>
        <HomeIcon />
        <span>Home</span>
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
    </nav>
  );
}
