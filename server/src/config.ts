import path from 'node:path';

import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Window applied to every rate limit bucket (global and per-route). */
export const RATE_LIMIT_TIME_WINDOW = '1 minute';

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
  })
  .transform((env) => ({
    ...env,
    LOG_LEVEL: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? ('warn' as const) : ('info' as const)),
    RATE_LIMIT_ENABLED: env.RATE_LIMIT_ENABLED ?? env.NODE_ENV !== 'test',
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
