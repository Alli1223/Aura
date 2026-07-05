import { ApiError } from '../../api/client';

/** Turns an unknown thrown value into a user-facing message. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}

/** Formats an ISO timestamp for display, or a dash when null. */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human-friendly duration for task run times. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  // Round to whole seconds first so the minute/second split can't produce "60s".
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Rough "every N" interval label for a task's schedule. */
export function formatInterval(ms: number): string {
  if (ms <= 0) return 'disabled';
  const minutes = ms / 60000;
  if (minutes < 60) return `every ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `every ${Math.round(hours)} h`;
  return `every ${Math.round(hours / 24)} d`;
}

/**
 * Generates a strong, human-legible temporary password. The server accepts any
 * password >= its minimum length; this yields a mixed-case + digit string the
 * admin can hand to the user, who must change it on next login.
 */
export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const length = 16;
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[values[i]! % alphabet.length];
  }
  return out;
}
