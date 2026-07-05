import styles from './ErrorState.module.css';

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  /** Centre in the full viewport (boot-level errors). */
  fullPage?: boolean;
}

export function ErrorState({
  title = 'Something went wrong',
  message = 'Please try again.',
  onRetry,
  fullPage = false,
}: ErrorStateProps) {
  return (
    <div className={fullPage ? styles.fullPage : styles.inline} role="alert">
      <div className={styles.card}>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.message}>{message}</p>
        {onRetry && (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
