import { NavLink, Outlet } from 'react-router';

import { Page, PageHeader } from '../../components/Page';
import styles from './Admin.module.css';

const TABS = [
  { to: '/admin', label: 'Users', end: true },
  { to: '/admin/libraries', label: 'Libraries', end: false },
  { to: '/admin/access', label: 'Access', end: false },
  { to: '/admin/settings', label: 'Settings', end: false },
  { to: '/admin/tasks', label: 'Tasks', end: false },
];

/** Admin shell: the "Admin" header, a section sub-nav and the routed section. */
export function AdminLayout() {
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab;

  return (
    <Page>
      <PageHeader
        title="Admin"
        subtitle="Manage users, libraries, access grants, server settings and tasks."
      />

      <nav className={styles.subnav} aria-label="Admin sections">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={tabClass}>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </Page>
  );
}
