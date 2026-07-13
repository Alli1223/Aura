import { useEffect, useRef, useState } from 'react';

import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { downloadLogs, useLogs, LOG_LEVELS, type LogEntry, type LogLevel } from '../../api/logs';
import { errorMessage, formatDateTime } from './adminHelpers';
import styles from './Admin.module.css';

/** Filter value: a concrete level or "all" (no level filter). */
type LevelFilter = LogLevel | 'all';

/** Maps a level name to its badge modifier class (colour coding). */
const LEVEL_CLASS: Record<string, string> = {
  trace: styles.logLevelTrace!,
  debug: styles.logLevelDebug!,
  info: styles.logLevelInfo!,
  warn: styles.logLevelWarn!,
  error: styles.logLevelError!,
  fatal: styles.logLevelFatal!,
};

function LevelBadge({ level }: { level: string }) {
  const modifier = LEVEL_CLASS[level] ?? styles.logLevelInfo!;
  return <span className={`${styles.logLevel} ${modifier}`}>{level}</span>;
}

/**
 * Admin Logs section: a level filter, an auto-refreshing (and manually
 * refreshable) tail of recent log entries rendered as monospace rows with a
 * colour-coded level badge, and a "Download logs" action for the full file.
 * Entries are chronological (oldest→newest); the list auto-scrolls to the newest
 * line as fresh entries arrive.
 */
export function AdminLogsPage() {
  const [level, setLevel] = useState<LevelFilter>('all');
  const logs = useLogs(level === 'all' ? {} : { level });
  const [banner, setBanner] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const entries: LogEntry[] = logs.data ?? [];

  // Keep the newest line in view as the tail grows (best-effort; jsdom-safe).
  // Depends on the query data reference (stable between renders unless it
  // changes), not the `entries` fallback array which is fresh every render.
  useEffect(() => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [logs.data]);

  const onDownload = () => {
    setBanner(null);
    setDownloading(true);
    downloadLogs()
      .catch((error: unknown) => setBanner(errorMessage(error)))
      .finally(() => setDownloading(false));
  };

  return (
    <section className={styles.section} aria-labelledby="logs-heading">
      <div className={styles.toolbar}>
        <h2 id="logs-heading" className={styles.toolbarTitle}>
          Server logs
        </h2>
        <div className={styles.toolbarActions}>
          <label className="visually-hidden" htmlFor="log-level">
            Filter by level
          </label>
          <select
            id="log-level"
            className={styles.select}
            value={level}
            onChange={(event) => setLevel(event.target.value as LevelFilter)}
          >
            <option value="all">All levels</option>
            {LOG_LEVELS.map((name) => (
              <option key={name} value={name}>
                {name} and above
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`btn btn-ghost ${styles.btnSm}`}
            disabled={logs.isFetching}
            onClick={() => void logs.refetch()}
          >
            {logs.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${styles.btnSm}`}
            disabled={downloading}
            onClick={onDownload}
          >
            {downloading ? 'Preparing…' : 'Download logs'}
          </button>
        </div>
      </div>

      {banner !== null && (
        <p className="alert alert-error" role="alert">
          {banner}
        </p>
      )}

      {logs.isPending ? (
        <div className={styles.stateBlock}>
          <Spinner label="Loading logs" />
        </div>
      ) : logs.isError ? (
        <ErrorState
          title="Couldn't load logs"
          message={errorMessage(logs.error)}
          onRetry={() => void logs.refetch()}
        />
      ) : entries.length === 0 ? (
        <div className={styles.stateBlock}>
          No log entries{level === 'all' ? '' : ` at ${level} or above`} yet.
        </div>
      ) : (
        <div className={styles.logList} ref={listRef} role="log" aria-label="Recent log entries">
          {entries.map((entry, index) => (
            <div key={`${entry.time ?? ''}-${index}`} className={styles.logRow}>
              <time className={styles.logTime}>{formatDateTime(entry.time)}</time>
              <LevelBadge level={entry.level} />
              <span className={styles.logMsg}>{entry.msg}</span>
              {typeof entry.reqId === 'string' && (
                <span className={styles.logReqId}>{entry.reqId}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
