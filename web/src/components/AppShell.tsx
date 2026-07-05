import { useState } from 'react';
import { Outlet } from 'react-router';

import { CloseIcon } from './Icons';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './AppShell.module.css';

/** Authenticated layout: top bar, permitted-libraries sidebar, routed content. */
export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div className={styles.shell}>
      <TopBar onMenuClick={() => setDrawerOpen(true)} />

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <Sidebar />
        </aside>

        <main className={styles.content}>
          <Outlet />
        </main>
      </div>

      {/* Mobile drawer */}
      <div
        className={`${styles.drawerOverlay} ${drawerOpen ? styles.drawerOpen : ''}`}
        hidden={!drawerOpen}
      >
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close navigation menu"
          onClick={closeDrawer}
        />
        <div className={styles.drawer} role="dialog" aria-label="Navigation" aria-modal="true">
          <div className={styles.drawerHeader}>
            <span className={styles.drawerTitle}>Menu</span>
            <button
              type="button"
              className={styles.drawerClose}
              aria-label="Close navigation menu"
              onClick={closeDrawer}
            >
              <CloseIcon />
            </button>
          </div>
          <Sidebar onNavigate={closeDrawer} />
        </div>
      </div>
    </div>
  );
}
