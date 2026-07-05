import styles from './Spinner.module.css';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className={styles.spinner} role="status" aria-label={label}>
      <span className={styles.visuallyHidden}>{label}</span>
    </span>
  );
}

/** Full-viewport centred spinner for boot / route-level loading. */
export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className={styles.fullPage}>
      <Spinner label={label} />
    </div>
  );
}
