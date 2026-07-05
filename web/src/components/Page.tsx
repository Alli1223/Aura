import type { ReactNode } from 'react';

import styles from './Page.module.css';

export function Page({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
    </div>
  );
}

/** Placeholder body for screens whose real content lands in a later item. */
export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className={styles.empty}>
      <h2 className={styles.emptyTitle}>{title}</h2>
      <p className={styles.emptyMessage}>{message}</p>
    </div>
  );
}
