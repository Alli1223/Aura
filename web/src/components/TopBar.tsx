import { Link } from 'react-router';

import { usePublicSettings } from '../api/queries';
import { MenuIcon } from './Icons';
import { NewMediaMenu } from './NewMediaMenu';
import { SearchBox } from './SearchBox';
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

      <SearchBox />

      <div className={styles.right}>
        <NewMediaMenu />
        <UserMenu />
      </div>
    </header>
  );
}
