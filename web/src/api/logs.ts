import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { API_BASE, apiRequest, fetchAuthedObjectUrl } from './client';

// Data layer for the admin log viewer: recent (level-filtered) log entries plus
// a download action. Mirrors the server contract in routes/logs.ts.

// ---- Levels -----------------------------------------------------------------

/** Selectable log levels, low→high severity (mirrors the server). */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// ---- DTOs -------------------------------------------------------------------

/** One parsed log entry (server ParsedLogEntry, minus the internal levelValue). */
export interface LogEntry {
  /** ISO timestamp, or null when the source line had no parseable time. */
  time: string | null;
  /** Canonical level name. */
  level: string;
  /** The log message. */
  msg: string;
  /** Request id when the line carried one. */
  reqId?: string;
  /** Any remaining structured fields (already redacted server-side). */
  [key: string]: unknown;
}

export interface LogsQuery {
  /** Only include entries at or above this level. */
  level?: LogLevel;
  /** Max entries to return (server clamps to its LOG_MAX_LINES cap). */
  limit?: number;
}

// ---- Query keys -------------------------------------------------------------

export const logsKeys = {
  all: ['admin', 'logs'] as const,
  list: (query: LogsQuery) => ['admin', 'logs', query.level ?? 'all', query.limit ?? 0] as const,
};

/** How often the Logs section re-polls while mounted (ms). */
export const LOGS_POLL_MS = 5000;

// ---- Requests ---------------------------------------------------------------

export async function getLogs(query: LogsQuery = {}): Promise<LogEntry[]> {
  const params = new URLSearchParams();
  if (query.level !== undefined) params.set('level', query.level);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.toString();
  const data = await apiRequest<{ entries: LogEntry[] }>(`/logs${suffix === '' ? '' : `?${suffix}`}`);
  return data.entries;
}

/**
 * Downloads the raw log file. The endpoint is admin-authenticated (a plain
 * `<a href>` can't send the bearer token), so fetch it with auth into a blob
 * object URL and trigger a browser download via a transient anchor.
 */
export async function downloadLogs(): Promise<void> {
  const objectUrl = await fetchAuthedObjectUrl(`${API_BASE}/logs/download`);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'aura.log';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ---- Hooks ------------------------------------------------------------------

/**
 * Recent log entries for the given filter, re-polled every LOGS_POLL_MS while
 * the section is mounted so the tail stays current without a manual refresh.
 */
export function useLogs(query: LogsQuery): UseQueryResult<LogEntry[]> {
  return useQuery({
    queryKey: logsKeys.list(query),
    queryFn: () => getLogs(query),
    refetchInterval: LOGS_POLL_MS,
  });
}
