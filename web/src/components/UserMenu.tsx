import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { useAuth } from '../auth/context';
import { AdminIcon, ChevronDownIcon, LogoutIcon, SettingsIcon } from './Icons';
import styles from './UserMenu.module.css';

/** Top-bar account menu: profile/settings, admin (when admin), logout. */
export function UserMenu() {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const initial = (user?.username ?? '?').charAt(0).toUpperCase();

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const handleLogout = () => {
    setOpen(false);
    void logout();
  };

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initial}
        </span>
        <span className={styles.username}>{user?.username}</span>
        <ChevronDownIcon width={16} height={16} />
      </button>

      {open && (
        <div className={styles.menu} id={menuId} role="menu">
          <div className={styles.header}>
            <div className={styles.headerName}>{user?.username}</div>
            {user?.email && <div className={styles.headerEmail}>{user.email}</div>}
          </div>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => go('/settings')}
          >
            <SettingsIcon width={18} height={18} />
            <span>Settings</span>
          </button>
          {isAdmin && (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => go('/admin')}
            >
              <AdminIcon width={18} height={18} />
              <span>Admin</span>
            </button>
          )}
          <div className={styles.divider} />
          <button type="button" role="menuitem" className={styles.item} onClick={handleLogout}>
            <LogoutIcon width={18} height={18} />
            <span>Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
