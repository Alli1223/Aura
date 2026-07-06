import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { sendError } from '../lib/errors.js';
import { parseParams } from '../lib/validation.js';
import { ensureTrickplay, trickplayCacheRoot } from '../media/trickplay.js';
import { getScanState, startScan, type ScanState } from '../scanner/scan-manager.js';
import type { TrickplayScanHook } from '../scanner/scan.js';

// Scan trigger + status endpoints. All admin-only: scanning is a server
// maintenance operation and scan state (paths, error messages) must not
// leak to regular users. Registered on the /api prefix because the routes
// span /api/libraries/:id/scan and /api/scan.

export interface ScanRoutesOptions {
  config: Config;
}

const LIBRARY_NOT_FOUND_MESSAGE = 'Library not found';

/**
 * How many freshly added/updated files one manual scan pre-warms trickplay for.
 * A hard bound so a first scan of a large library is never blocked decoding
 * every video for previews — the rest are generated on demand at scrub time.
 */
const TRICKPLAY_SCAN_PREWARM_CAP = 50;

/**
 * A bounded, best-effort trickplay pre-warm hook for a manual scan, or
 * undefined when trickplay is disabled (so the scanner does no preview work).
 * Each returned hook caps itself at TRICKPLAY_SCAN_PREWARM_CAP files; beyond
 * that, previews are generated on demand at scrub time.
 */
function makeTrickplayHook(config: Config, log: FastifyBaseLogger): TrickplayScanHook | undefined {
  if (!config.TRICKPLAY_ENABLED) return undefined;
  const cacheRoot = trickplayCacheRoot(config.CONFIG_DIR);
  let generated = 0;
  return async (file) => {
    if (generated >= TRICKPLAY_SCAN_PREWARM_CAP) return;
    generated += 1;
    await ensureTrickplay(file, {
      cacheRoot,
      mediaRoots: config.MEDIA_ROOTS,
      intervalSec: config.TRICKPLAY_INTERVAL_SEC,
      thumbWidth: config.TRICKPLAY_THUMB_WIDTH,
    });
    log.debug({ mediaFileId: file.id }, 'scan: pre-warmed trickplay');
  };
}

const libraryIdParamsSchema = z.object({ id: z.string().min(1, 'Library id is required') });

/** Public shape of a library's scan state. */
function toScanResponse(libraryId: string, state: ScanState) {
  return {
    libraryId,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    stats: state.stats,
    error: state.error,
  };
}

export const scanRoutes: FastifyPluginAsync<ScanRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();
  const mediaRoots = opts.config.MEDIA_ROOTS;
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // Trigger a scan of one library. 202 on start, 409 while one is running.
  app.post('/libraries/:id/scan', adminOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const library = await prisma.library.findUnique({ where: { id: params.id } });
    if (library === null) {
      return sendError(reply, 404, 'NOT_FOUND', LIBRARY_NOT_FOUND_MESSAGE);
    }

    const trickplay = makeTrickplayHook(opts.config, request.log);
    if (!startScan(library.id, { mediaRoots, log: request.log, ...(trickplay ? { trickplay } : {}) })) {
      return sendError(
        reply,
        409,
        'SCAN_IN_PROGRESS',
        'A scan is already running for this library',
      );
    }

    await writeAuditLog(
      prisma,
      {
        action: 'library.scan_started',
        userId: request.user.id,
        targetType: 'library',
        targetId: library.id,
        ip: request.ip,
        details: { name: library.name },
      },
      request.log,
    );

    return reply.status(202).send({ started: true });
  });

  // Current scan state (live counters while scanning, last result when idle).
  app.get('/libraries/:id/scan', adminOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const library = await prisma.library.findUnique({ where: { id: params.id } });
    if (library === null) {
      return sendError(reply, 404, 'NOT_FOUND', LIBRARY_NOT_FOUND_MESSAGE);
    }

    return { scan: toScanResponse(library.id, getScanState(library.id)) };
  });

  // Trigger scans for every library, skipping ones that are already
  // scanning. Always 202: the response lists what was started vs skipped.
  app.post('/scan', adminOnly, async (request, reply) => {
    const libraries = await prisma.library.findMany({ orderBy: { name: 'asc' } });

    const results = libraries.map((library) => {
      const trickplay = makeTrickplayHook(opts.config, request.log);
      return {
        libraryId: library.id,
        name: library.name,
        started: startScan(library.id, {
          mediaRoots,
          log: request.log,
          ...(trickplay ? { trickplay } : {}),
        }),
      };
    });

    for (const result of results) {
      if (!result.started) continue;
      await writeAuditLog(
        prisma,
        {
          action: 'library.scan_started',
          userId: request.user.id,
          targetType: 'library',
          targetId: result.libraryId,
          ip: request.ip,
          details: { name: result.name, scope: 'all' },
        },
        request.log,
      );
    }

    return reply.status(202).send({ libraries: results });
  });
};
