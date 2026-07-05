import type { ReactNode } from 'react';

import { usePublicSettings } from '../api/queries';
import styles from './AuthLayout.module.css';

/** Centred card used by the login and register screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const settings = usePublicSettings();
  const serverName = settings.data?.serverName ?? 'Aura';

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            A
          </span>
          <span className={styles.brandName}>{serverName}</span>
        </div>
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        <div className={styles.content}>{children}</div>
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}
