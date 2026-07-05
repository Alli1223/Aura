import { useEffect, useId, type ReactNode } from 'react';

import styles from './Admin.module.css';

export interface DialogProps {
  title: string;
  children: ReactNode;
  /** Rendered in the action row (buttons). */
  actions: ReactNode;
  onClose: () => void;
}

/**
 * A small accessible modal dialog: role="dialog", labelled by its title,
 * closes on Escape or a scrim click. Used for confirmations, the temp-password
 * reveal and the library create/edit form.
 */
export function Dialog({ title, children, actions, onClose }: DialogProps) {
  const titleId = useId();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className={styles.dialogScrim}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.dialogTitle}>
          {title}
        </h2>
        <div className={styles.dialogBody}>{children}</div>
        <div className={styles.dialogActions}>{actions}</div>
      </div>
    </div>
  );
}
