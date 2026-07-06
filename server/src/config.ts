import path from 'node:path';

import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Window applied to every rate limit bucket (global and per-route). */
export const RATE_LIMIT_TIME_WINDOW = '1 minute';

/**
 * Default lifetime of a signed streaming token (6 hours): long enough to
 * cover a feature film plus pauses, short enough to bound the exposure of a
 * leaked URL. Overridable via STREAM_TOKEN_TTL_MS.
 */
export const DEFAULT_STREAM_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Accepts an origin like `https://app.example.com` (scheme + host + optional
 * port, no path). A single trailing slash is tolerated and stripped.
 */
function normaliseOrigin(value: string): string | undefined {
  const candidate = value.endsWith('/') ? value.slice(0, -1) : value;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.origin !== candidate) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8096),
    /**
     * Directory for persistent server state (DB, cache, transcodes, secrets).
     * Defaults to ./config so development boots without root permissions;
     * the Docker image sets CONFIG_DIR=/config (the mounted config volume).
     */
    CONFIG_DIR: z.string().min(1).default('./config'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Directory containing the built web app. Only served if it exists, so the
    // default is harmless in development (Vite serves the web app instead).
    WEB_DIST: z.string().min(1).default('/app/web/dist'),
    /**
     * Trust X-Forwarded-* headers for the client IP (rate limit keys, audit
     * log IPs). MUST only be enabled when a trusted reverse proxy sets those
     * headers; otherwise clients can spoof their IP.
     */
    TRUST_PROXY: z.stringbool().default(false),
    /**
     * Comma-separated list of origins allowed to make cross-origin requests
     * (with credentials). Empty (the default) denies all cross-origin access:
     * the web app is served same-origin so browsers need no CORS headers.
     */
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value, ctx) => {
        const entries = value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        const origins: string[] = [];
        for (const entry of entries) {
          const origin = normaliseOrigin(entry);
          if (origin === undefined) {
            ctx.addIssue({
              code: 'custom',
              message: `CORS_ORIGINS entry "${entry}" is not a valid origin (expected e.g. https://app.example.com)`,
            });
            continue;
          }
          origins.push(origin);
        }
        return origins;
      }),
    /**
     * Comma-separated list of absolute directory paths under which all
     * library folders must live (path-traversal defence: no library path is
     * ever accepted outside these roots). The Docker image mounts host media
     * under /media, hence the default.
     */
    MEDIA_ROOTS: z
      .string()
      .default('/media')
      .transform((value, ctx) => {
        const entries = value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        const roots: string[] = [];
        for (const entry of entries) {
          if (!path.isAbsolute(entry)) {
            ctx.addIssue({
              code: 'custom',
              message: `MEDIA_ROOTS entry "${entry}" must be an absolute path`,
            });
            continue;
          }
          // Normalise (collapse //, resolve ./.., strip trailing slash) so
          // containment checks compare like with like.
          const normalised = path.resolve(entry);
          if (!roots.includes(normalised)) roots.push(normalised);
        }
        if (roots.length === 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'MEDIA_ROOTS must contain at least one absolute path',
          });
        }
        return roots;
      }),
    /** Pino log level. Defaults to "info" ("warn" when NODE_ENV=test). */
    LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
    /**
     * Master switch for rate limiting. Defaults to enabled, except under
     * NODE_ENV=test where it defaults to disabled so test suites can hammer
     * the API (rate limit tests re-enable it explicitly).
     */
    RATE_LIMIT_ENABLED: z.stringbool().optional(),
    /** Global per-IP request budget per minute. */
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
    /** Per-IP budget per minute for login/register (credential guessing). */
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
    /** Per-IP budget per minute for token refresh. */
    RATE_LIMIT_REFRESH_MAX: z.coerce.number().int().min(1).default(30),
    /**
     * Lifetime of signed streaming tokens in milliseconds. Bounded below at
     * one second (shorter would break playback outright) and above at seven
     * days (long-lived streaming URLs defeat the point of signing them).
     */
    STREAM_TOKEN_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(7 * 24 * 60 * 60 * 1000)
      .default(DEFAULT_STREAM_TOKEN_TTL_MS),
    /**
     * How long an HLS transcode session may sit with no playlist/segment
     * request before the idle reaper kills its ffmpeg and deletes its scratch
     * dir. Default 60s; bounded at one second below and a day above.
     */
    HLS_SESSION_IDLE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1000)
      .default(60_000),
    /**
     * Maximum number of concurrent HLS transcode sessions. Requests beyond
     * this cap are rejected (503) rather than starting another ffmpeg; an
     * identical (file,user,quality) request reuses the live session instead.
     */
    HLS_MAX_SESSIONS: z.coerce.number().int().min(1).max(64).default(3),
    /**
     * Master switch for the filesystem library watcher (near-realtime rescans
     * on media changes). Defaults to enabled, except under NODE_ENV=test where
     * it defaults to disabled so the suite never spawns real chokidar watchers
     * (watcher tests construct instances explicitly).
     */
    WATCH_ENABLED: z.stringbool().optional(),
    /**
     * Quiet period (ms) the watcher waits after the last filesystem event for
     * a library before triggering a scan, coalescing a burst of add/remove
     * events (e.g. a folder copy) into a single scan. Default 10s.
     */
    WATCH_DEBOUNCE_MS: z.coerce.number().int().min(0).max(600_000).default(10_000),
    /**
     * Interval (ms) between scheduled full rescans of every library. 0 (the
     * effective floor) disables the periodic scheduler entirely. Default 6h.
     * The scheduled-tasks runner reads this as the `library-scan-all` task's
     * interval (a value of 0 leaves the task registered but disabled).
     */
    SCAN_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60 * 1000)
      .default(6 * 60 * 60 * 1000),
    /**
     * Master switch for the periodic maintenance task runner (library scans,
     * transcode/artwork cleanup, DB backup). Defaults to enabled, except under
     * NODE_ENV=test where it defaults to disabled so the suite never
     * auto-schedules background work (task tests build runners explicitly).
     */
    TASKS_ENABLED: z.stringbool().optional(),
    /**
     * Interval (ms) between transcode-scratch cleanups. 0 disables the task.
     * Default 1h.
     */
    TRANSCODE_CLEANUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60 * 1000)
      .default(60 * 60 * 1000),
    /**
     * Age (ms) a transcode scratch dir (HLS session dir or subtitle cache
     * entry) must exceed before the cleanup task removes it. Kept comfortably
     * above HLS_SESSION_IDLE_MS so a dir old enough to sweep cannot belong to a
     * live/recently-active session (the idle reaper would already have taken
     * it). Default 1h.
     */
    TRANSCODE_CLEANUP_MAX_AGE_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1000)
      .default(60 * 60 * 1000),
    /**
     * Interval (ms) between artwork-cache eviction runs. 0 disables the task.
     * Default 6h.
     */
    ARTWORK_EVICT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60 * 1000)
      .default(6 * 60 * 60 * 1000),
    /**
     * Byte budget the artwork cache is trimmed down to on each eviction run
     * (LRU-ish: least recently used files are deleted first). Default 1 GiB.
     */
    ARTWORK_CACHE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .default(1024 * 1024 * 1024),
    /**
     * Interval (ms) between SQLite hot backups (`VACUUM INTO`). 0 disables the
     * task. Default 24h.
     */
    DB_BACKUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60 * 1000)
      .default(24 * 60 * 60 * 1000),
    /**
     * Number of most-recent database backups to retain under
     * `${CONFIG_DIR}/backups`; older backups are pruned after each run.
     * Default 7.
     */
    BACKUP_RETENTION: z.coerce.number().int().min(1).max(365).default(7),
    /**
     * Per-attempt timeout (ms) for an outbound webhook delivery. Each delivery
     * makes up to two attempts (one retry); the AbortController fires this
     * timeout on each. Default 5s; bounded at 100ms below and 60s above.
     */
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  })
  .transform((env) => ({
    ...env,
    LOG_LEVEL: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? ('warn' as const) : ('info' as const)),
    RATE_LIMIT_ENABLED: env.RATE_LIMIT_ENABLED ?? env.NODE_ENV !== 'test',
    WATCH_ENABLED: env.WATCH_ENABLED ?? env.NODE_ENV !== 'test',
    TASKS_ENABLED: env.TASKS_ENABLED ?? env.NODE_ENV !== 'test',
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}

export const config = loadConfig();
