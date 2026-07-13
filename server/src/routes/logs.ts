import { createReadStream, existsSync } from 'node:fs';

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Config } from '../config.js';
import { sendError } from '../lib/errors.js';
import { FILTERABLE_LEVELS, readRecentLogs, type ParsedLogEntry } from '../lib/log-file.js';

// Admin-only log viewer API over the persisted JSONL log file (see
// lib/log-file.ts + app.ts). Both routes are admin-only: server logs are
// operator information (they can reference usernames, ids, request context),
// mirroring the scan/task/activity admin surfaces. There is no un-redacted
// field here — the reader only ever sees what the logger already wrote, and
// redaction is enforced at the logger level, so secrets never reach the file.
//
//   GET /api/logs?level=&limit=  — the most recent parsed entries, optionally
//                                  filtered to level >= `level`.
//   GET /api/logs/download       — the raw active log file as an attachment.

export interface LogsRoutesOptions {
  config: Config;
}

/** Default page size for GET /api/logs when the caller omits `limit`. */
const DEFAULT_LIMIT = 500;

const logsQuerySchema = z.object({
  level: z.enum(FILTERABLE_LEVELS).optional(),
  limit: z.coerce
    .number()
    .int('limit must be an integer')
    .positive('limit must be positive')
    .optional(),
});

/** Strips the internal `levelValue` so the wire shape is `{ time, level, msg, ...fields }`. */
function toResponseEntry(entry: ParsedLogEntry): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key !== 'levelValue') rest[key] = value;
  }
  return rest;
}

export const logsRoutes: FastifyPluginAsync<LogsRoutesOptions> = async (app, opts) => {
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };
  const { LOG_FILE, LOG_MAX_LINES } = opts.config;

  // Most-recent entries, newest last (chronological), capped at LOG_MAX_LINES.
  app.get('/', adminOnly, async (request, reply) => {
    const query = logsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'VALIDATION',
        query.error.issues[0]?.message ?? 'Invalid query parameters',
      );
    }

    const limit = Math.min(query.data.limit ?? DEFAULT_LIMIT, LOG_MAX_LINES);
    const entries = readRecentLogs({
      filePath: LOG_FILE,
      minLevel: query.data.level,
      limit,
      maxLines: LOG_MAX_LINES,
    });
    return { entries: entries.map(toResponseEntry) };
  });

  // The raw active log file as a downloadable NDJSON attachment. When file
  // logging is disabled or nothing has been logged yet the file is absent —
  // respond with an empty attachment rather than an error so the UI's download
  // action never fails.
  app.get('/download', adminOnly, async (_request, reply) => {
    void reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    void reply.header('Content-Disposition', 'attachment; filename="aura.log"');
    if (!existsSync(LOG_FILE)) {
      return reply.send('');
    }
    return reply.send(createReadStream(LOG_FILE));
  });
};
