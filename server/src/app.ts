import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';

import { authenticate } from './auth/authenticate.js';
import { requireAdmin } from './auth/guards.js';
import { ACCESS_TOKEN_TTL } from './auth/types.js';
import { loadConfig, RATE_LIMIT_TIME_WINDOW, type Config } from './config.js';
import { sendError } from './lib/errors.js';
import { loadOrCreateSecrets } from './lib/secrets.js';
import { getSetting } from './lib/settings.js';
import { HlsSessionManager } from './streaming/hls-session.js';
import { accessRoutes } from './routes/access.js';
import { activityRoutes } from './routes/activity.js';
import { adminStatsRoutes } from './routes/admin-stats.js';
import { apiTokenRoutes } from './routes/api-tokens.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { historyRoutes } from './routes/history.js';
import { imageRoutes } from './routes/images.js';
import { libraryRoutes } from './routes/libraries.js';
import { mediaRoutes } from './routes/media.js';
import { qualityRoutes } from './routes/qualities.js';
import { scanRoutes } from './routes/scan.js';
import { searchRoutes } from './routes/search.js';
import { settingsRoutes } from './routes/settings.js';
import { streamRoutes } from './routes/stream.js';
import { subtitleRoutes } from './routes/subtitles.js';
import { tasksRoutes } from './routes/tasks.js';
import { trickplayRoutes } from './routes/trickplay.js';
import { userRoutes } from './routes/users.js';
import { watchRoutes } from './routes/watch.js';
import { webhookRoutes } from './routes/webhooks.js';
import { appVersion } from './version.js';

export interface BuildAppOptions {
  /**
   * Directory containing the built web app (index.html + assets). When it
   * exists it is served as the static root with an SPA fallback; when it
   * doesn't (development, tests) the server is API-only.
   */
  webDistDir?: string;
}

/** Maximum accepted request body size (API payloads are small JSON). */
export const BODY_LIMIT_BYTES = 1024 * 1024; // 1 MiB

/** Request id header honoured on requests and echoed on every response. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Route prefix for the OpenAPI docs (Swagger UI at `/api/docs`, spec at `/api/docs/json`). */
export const DOCS_ROUTE_PREFIX = '/api/docs';

/**
 * Content-Security-Policy applied ONLY to the Swagger UI routes. The global
 * policy (see below) stays strict; this narrow override adds just what the
 * bundled UI needs: it loads its own scripts/styles same-origin (`'self'`, no
 * inline/eval), injects component styles inline at runtime ('unsafe-inline'
 * for style-src — already permitted globally), and embeds icons/fonts as
 * `data:` URIs. Scoped to `/api/docs*` so it can never relax the app's CSP.
 */
const DOCS_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Log fields that must never reach the log output. Fastify's default
 * serializers do not log headers or bodies, but these paths keep secrets out
 * even if a custom log call passes a request/response-shaped object.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'body.password',
  '*.password',
  'req.body.tmdbApiKey',
  'body.tmdbApiKey',
  '*.tmdbApiKey',
];

type LoggerOption = FastifyServerOptions['logger'];

/**
 * Applies the hardening defaults (level from config, secret redaction) to
 * whatever logger option the caller passed. Redaction paths are always
 * enforced; tests may inject a stream but cannot drop redaction.
 */
function resolveLoggerOptions(config: Config, logger: LoggerOption): LoggerOption {
  if (logger === false) return false;
  const base = {
    level: config.LOG_LEVEL,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  };
  if (logger === undefined) {
    // Silent by default under test so suites stay readable; callers opt in.
    return config.NODE_ENV === 'test' ? false : base;
  }
  if (logger === true) return base;
  return { ...logger, ...base, level: logger.level ?? base.level };
}

export function buildApp(
  options: FastifyServerOptions = {},
  { webDistDir }: BuildAppOptions = {},
): FastifyInstance {
  // Read the environment here (not at module load) so tests can point
  // CONFIG_DIR/NODE_ENV at per-test values before building the app.
  const config = loadConfig();
  const secrets = loadOrCreateSecrets(config.CONFIG_DIR);

  const app = Fastify({
    // Only trust X-Forwarded-* headers when explicitly configured; otherwise
    // clients could spoof the IP used for rate limiting and audit logs.
    trustProxy: config.TRUST_PROXY,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: () => randomUUID(),
    ...options,
    logger: resolveLoggerOptions(config, options.logger),
  });

  // Echo the request id so clients/proxies can correlate responses with logs.
  app.addHook('onRequest', async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Secure headers. The CSP is written for the SPA + HLS playback: hls.js
  // fetches segments via XHR (connect-src 'self') and plays through
  // MediaSource blob: URLs (media-src blob:).
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // COEP breaks media playback and brings no benefit here.
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  void app.register(cookie);
  // Strict default: no cross-origin access. The web app is served same-origin
  // (Vite dev proxy in development, static files from this server in
  // production). Operators can allow specific origins via CORS_ORIGINS.
  void app.register(
    cors,
    config.CORS_ORIGINS.length > 0
      ? { origin: config.CORS_ORIGINS, credentials: true }
      : { origin: false },
  );

  if (config.RATE_LIMIT_ENABLED) {
    void app.register(rateLimit, {
      global: true,
      max: config.RATE_LIMIT_MAX,
      timeWindow: RATE_LIMIT_TIME_WINDOW,
      // The plugin throws this into the app error handler, producing the
      // standard shape { error: { code: 'RATE_LIMITED', message } }.
      errorResponseBuilder: (_request, context) => {
        const err = new Error(`Rate limit exceeded, retry in ${context.after}`) as Error & {
          statusCode: number;
          code: string;
        };
        err.statusCode = context.statusCode;
        err.code = 'RATE_LIMITED';
        return err;
      },
    });
  }

  void app.register(jwt, {
    secret: secrets.jwtSecret,
    sign: { expiresIn: ACCESS_TOKEN_TTL },
  });

  app.decorate('authenticate', authenticate);
  app.decorate('requireAdmin', requireAdmin);

  // One HLS transcode session manager for the server lifetime, created here so
  // it can be shared by BOTH the stream plugin (starts/serves/stops sessions)
  // and the admin activity plugin (lists/kills them). Killed on server shutdown
  // so no ffmpeg process or scratch dir leaks. Hardware-acceleration mode is
  // read per-session (an admin toggle takes effect without a restart) with an
  // automatic software fallback inside the manager.
  const hls = new HlsSessionManager({
    mediaRoots: config.MEDIA_ROOTS,
    getTranscodeDir: () => getSetting('transcodeDir', app.log),
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
    idleMs: config.HLS_SESSION_IDLE_MS,
    maxSessions: config.HLS_MAX_SESSIONS,
    getHwAccel: () => getSetting('hwAccel', app.log),
    hwAccelDevice: config.HWACCEL_DEVICE,
    logger: app.log,
  });
  app.addHook('onClose', async () => {
    await hls.shutdown();
  });

  // OpenAPI spec + Swagger UI. `@fastify/swagger` must be registered before the
  // routes it documents (it captures them via an onRoute hook), so it goes here
  // ahead of every app.register(...routes...) below. The UI is served at
  // /api/docs and the raw spec at /api/docs/json.
  void app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Aura API',
        description:
          'HTTP API for the Aura media server. Authenticate with a JWT access ' +
          'token (Authorization: Bearer <jwt>) or a personal API token ' +
          '(X-Api-Token: aura_..., or Authorization: Bearer aura_...). Read-only ' +
          'tokens may only issue GET/HEAD requests.',
        version: appVersion,
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiToken: { type: 'apiKey', in: 'header', name: 'X-Api-Token' },
        },
      },
    },
  });
  void app.register(swaggerUi, {
    routePrefix: DOCS_ROUTE_PREFIX,
    uiConfig: { docExpansion: 'list', deepLinking: false },
  });

  // Narrowly relax the CSP for the Swagger UI routes only (see the constant).
  // onSend runs after helmet's onRequest hook, so this override wins for docs
  // requests while every other route keeps the strict global policy.
  app.addHook('onSend', async (request, reply) => {
    if (request.url === DOCS_ROUTE_PREFIX || request.url.startsWith(`${DOCS_ROUTE_PREFIX}/`)) {
      void reply.header('content-security-policy', DOCS_CONTENT_SECURITY_POLICY);
    }
  });

  // Consistent JSON error shape for anything thrown or unhandled. 5xx bodies
  // are always generic: internal messages and stack traces are only logged.
  app.setErrorHandler((error, request, reply) => {
    const err = error instanceof Error ? (error as Partial<FastifyError> & Error) : undefined;
    const statusCode =
      err !== undefined && typeof err.statusCode === 'number' && err.statusCode >= 400
        ? err.statusCode
        : 500;
    if (err === undefined || statusCode >= 500) {
      request.log.error(error);
      sendError(reply, statusCode, 'INTERNAL', 'Internal server error');
      return;
    }
    sendError(reply, statusCode, err.code ?? 'BAD_REQUEST', err.message);
  });

  void app.register(healthRoutes, { prefix: '/api' });
  void app.register(authRoutes, { prefix: '/api/auth', config });
  void app.register(settingsRoutes, { prefix: '/api/settings' });
  void app.register(userRoutes, { prefix: '/api/users' });
  // Personal API tokens (self-service; JWT-only, never manageable via a token).
  void app.register(apiTokenRoutes, { prefix: '/api/api-tokens' });
  void app.register(libraryRoutes, { prefix: '/api/libraries', config });
  void app.register(imageRoutes, { prefix: '/api/items', config });
  void app.register(streamRoutes, {
    prefix: '/api/stream',
    config,
    streamTokenSecret: secrets.streamTokenSecret,
    hls,
  });
  // Admin activity dashboard: live transcode sessions + kill-session action.
  // Shares the HLS manager instance with the stream plugin above.
  void app.register(activityRoutes, { prefix: '/api/activity', hls });
  // Per-user selectable quality rungs for the player's quality menu.
  void app.register(qualityRoutes, { prefix: '/api/qualities' });
  // Subtitle listing + WebVTT serving, same prefix and token-auth as streamRoutes.
  void app.register(subtitleRoutes, {
    prefix: '/api/stream',
    config,
    streamTokenSecret: secrets.streamTokenSecret,
  });
  // Trickplay (scrub-preview sprite) manifest + sheets, same prefix and token-auth.
  void app.register(trickplayRoutes, {
    prefix: '/api/stream',
    config,
    streamTokenSecret: secrets.streamTokenSecret,
  });
  // Access grant routes span /api/access, /api/users/:id/libraries and
  // /api/libraries/:id/access, so the plugin registers on the /api prefix.
  void app.register(accessRoutes, { prefix: '/api' });
  // Scan routes span /api/libraries/:id/scan and /api/scan.
  void app.register(scanRoutes, { prefix: '/api', config });
  // Watch-progress routes span /api/items/:id/{progress,watched,state},
  // /api/items/state and /api/continue-watching.
  void app.register(watchRoutes, { prefix: '/api' });
  // Browse (read) API: /api/libraries/:id/{items,recently-added},
  // /api/items/:id, /api/items/:id/children and /api/home/recently-added.
  void app.register(mediaRoutes, { prefix: '/api' });
  // Search API: /api/search (access-scoped title/genre search).
  void app.register(searchRoutes, { prefix: '/api' });
  // Per-user watch history: /api/history and /api/history/:id.
  void app.register(historyRoutes, { prefix: '/api' });
  // Admin server-wide statistics: /api/admin/stats.
  void app.register(adminStatsRoutes, { prefix: '/api/admin' });
  // Admin scheduled-task status + manual trigger API.
  void app.register(tasksRoutes, { prefix: '/api/tasks' });
  // Admin outbound-webhook management API.
  void app.register(webhookRoutes, { prefix: '/api/webhooks' });

  if (webDistDir !== undefined && existsSync(webDistDir)) {
    const root = path.resolve(webDistDir);
    void app.register(fastifyStatic, { root });

    // SPA fallback: unknown non-API GET routes get index.html so client-side
    // routing works. API routes keep Fastify's default JSON 404 shape.
    app.setNotFoundHandler(async (request, reply) => {
      const isApiRoute = request.url === '/api' || request.url.startsWith('/api/');
      if (request.method === 'GET' && !isApiRoute) {
        return reply.type('text/html; charset=utf-8').sendFile('index.html');
      }
      return reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
    });
  }

  return app;
}
