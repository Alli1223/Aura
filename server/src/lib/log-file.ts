import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

// Log-file persistence + reading for the admin log viewer.
//
// The logger (pino, configured in app.ts) writes newline-delimited JSON to this
// destination IN ADDITION to stdout, via pino.multistream. Crucially, redaction
// is applied at the pino logger level, BEFORE anything reaches a destination, so
// the bytes this module receives are already redacted — the file can never
// contain a secret the stdout logs wouldn't.
//
// Bounding: a single active file that rotates by size. When the file would grow
// past `maxBytes` it is renamed to `<file>.1` (one backup, overwriting any prior
// backup) and a fresh file is started. Disk use is therefore bounded at ~2x
// `maxBytes` with zero external dependencies. Writes are synchronous
// (appendFileSync): log volume for a media server is modest, and sync writes
// mean the read/download endpoints always observe fully-flushed data with no
// stream-lifecycle races (and nothing to close/flush on shutdown). pino's
// multistream only ever calls `.write` on this destination.

/** pino numeric level → canonical name, mirroring pino's default level map. */
export const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/** Canonical level name → pino numeric level. */
export const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** The level names accepted by the read endpoint's `level` filter, low→high. */
export const FILTERABLE_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevelName = (typeof FILTERABLE_LEVELS)[number];

export interface LogFileStreamOptions {
  /** Absolute-ish path of the active log file (its directory is created). */
  filePath: string;
  /** Rotate once the file would exceed this many bytes. */
  maxBytes: number;
}

/** A pino-multistream destination: something with a synchronous `write`. */
export interface LogFileDestination {
  write(chunk: string | Buffer): void;
}

/**
 * A synchronous destination that appends already-serialized (already-redacted)
 * log lines to a file, rotating by size (see the module header). Plugged into
 * pino.multistream, which only calls `.write`.
 */
export function createLogFileStream({ filePath, maxBytes }: LogFileStreamOptions): LogFileDestination {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = `${filePath}.1`;
  let size = existsSync(filePath) ? statSync(filePath).size : 0;

  return {
    write(chunk: string | Buffer): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Rotate before writing so a single oversized line still lands in a fresh
      // file rather than being dropped. Only rotate a non-empty file.
      if (size > 0 && size + buf.length > maxBytes) {
        renameSync(filePath, backupPath);
        size = 0;
      }
      appendFileSync(filePath, buf);
      size += buf.length;
    },
  };
}

/** A parsed log entry as returned by the read endpoint. */
export interface ParsedLogEntry {
  /** ISO timestamp (from pino's epoch-ms `time`), or null when unparseable. */
  time: string | null;
  /** Canonical level name (e.g. "info"), or "info" when unknown. */
  level: string;
  /** Numeric pino level, used only for filtering (not surfaced in the type). */
  levelValue: number;
  /** The log message. */
  msg: string;
  /** Any remaining structured fields (reqId, err, …); redacted upstream. */
  [key: string]: unknown;
}

/** Resolves a raw pino `level` (number or name) to its numeric value. */
function toLevelValue(level: unknown): number {
  if (typeof level === 'number') return level;
  if (typeof level === 'string') return LEVEL_VALUES[level] ?? 30;
  return 30;
}

/** Keys normalized onto the entry or dropped as constant noise (not copied through). */
const RESERVED_KEYS = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'v']);

/**
 * Parses one JSONL log line into a normalized entry, or null when the line is
 * malformed / not an object (callers skip nulls). `pid`/`hostname`/`v` are
 * dropped as constant noise; everything else rides along under the entry.
 */
export function parseLogLine(line: string): ParsedLogEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;

  const levelValue = toLevelValue(raw.level);
  let iso: string | null = null;
  if (typeof raw.time === 'number' && Number.isFinite(raw.time)) {
    const d = new Date(raw.time);
    if (!Number.isNaN(d.getTime())) iso = d.toISOString();
  } else if (typeof raw.time === 'string') {
    iso = raw.time;
  }

  const entry: ParsedLogEntry = {
    time: iso,
    level: LEVEL_NAMES[levelValue] ?? 'info',
    levelValue,
    msg: typeof raw.msg === 'string' ? raw.msg : '',
  };
  // Carry through any remaining structured fields (reqId, err, …).
  for (const [key, value] of Object.entries(raw)) {
    if (!RESERVED_KEYS.has(key)) entry[key] = value;
  }
  return entry;
}

export interface ReadLogsOptions {
  /** Absolute-ish path of the active log file. */
  filePath: string;
  /** Only keep entries at or above this level (severity), when set. */
  minLevel?: LogLevelName;
  /** Return at most this many entries (most-recent). */
  limit: number;
  /** Hard cap on raw lines scanned from the tail of the file(s). */
  maxLines: number;
}

/** Reads the last `maxLines` raw lines of the active file (+ backup to fill). */
function readTailLines(filePath: string, maxLines: number): string[] {
  const read = (p: string): string[] => {
    if (!existsSync(p)) return [];
    const text = readFileSync(p, 'utf8');
    // Split and drop the trailing empty element from a final newline.
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  let lines = read(filePath);
  // If the active file was just rotated it may hold fewer than we want; pull
  // the tail of the backup to fill the window so "most recent N" stays honest.
  if (lines.length < maxLines) {
    const backup = read(`${filePath}.1`);
    lines = [...backup, ...lines];
  }
  return lines.slice(-maxLines);
}

/**
 * Reads the most-recent log entries: tails the file, parses (skipping malformed
 * lines), optionally filters to level >= `minLevel`, then returns the last
 * `limit` entries in chronological order (oldest→newest).
 */
export function readRecentLogs(options: ReadLogsOptions): ParsedLogEntry[] {
  const { filePath, minLevel, limit, maxLines } = options;
  const threshold = minLevel !== undefined ? LEVEL_VALUES[minLevel] : undefined;

  const entries: ParsedLogEntry[] = [];
  for (const line of readTailLines(filePath, maxLines)) {
    const entry = parseLogLine(line);
    if (entry === null) continue;
    if (threshold !== undefined && entry.levelValue < threshold) continue;
    entries.push(entry);
  }
  return entries.slice(-limit);
}
