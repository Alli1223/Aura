import { Link } from 'react-router';

import { usePublicSettings } from '../api/queries';
import { MenuIcon, SearchIcon } from './Icons';
import { UserMenu } from './UserMenu';
import styles from './TopBar.module.css';

export interface TopBarProps {
  /** Toggle the mobile navigation drawer. */
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const settings = usePublicSettings();
  const serverName = settings.data?.serverName ?? 'Aura';

  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        <button
          type="button"
          className={styles.menuButton}
          onClick={onMenuClick}
          aria-label="Open navigation menu"
        >
          <MenuIcon />
        </button>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            A
          </span>
          <span className={styles.brandName}>{serverName}</span>
        </Link>
      </div>

      <div className={styles.search}>
        <SearchIcon className={styles.searchIcon} width={18} height={18} />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search"
          aria-label="Search"
          disabled
        />
      </div>

      <div className={styles.right}>
        <UserMenu />
      </div>
    </header>
  );
}
