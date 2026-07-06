import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  assertMediaItemAccess,
  getAccessibleLibraryIds,
  resolveRatingFilter,
} from '../auth/access.js';
import { getUserHistory } from '../lib/history.js';
import { sendError } from '../lib/errors.js';
import { parseParams } from '../lib/validation.js';
import { clearWatchState } from '../lib/watch-state.js';

// Per-user watch history:
//   GET    /api/history?limit=&page=  — the caller's watched/in-progress items
//                                        across PERMITTED libraries, most-recent
//                                        activity first, paginated.
//   DELETE /api/history/:itemId       — clear the caller's watch state for one
//                                        item ("remove from history").
//
// History is derived from WatchState (there is no event log); see lib/history.ts
// for the rationale. Both routes authenticate and re-check access through the
// shared helpers, so an ungranted or nonexistent item yields the byte-identical
// cloaking 404 (parental-controls cap included).
//
// Registered on the /api prefix (routes span /api/history and /api/history/:id).

const HISTORY_DEFAULT_LIMIT = 24;
const HISTORY_MAX_LIMIT = 100;

const historyQuerySchema = z.object({
  // Page size, named `limit` to match the documented query contract.
  limit: z.coerce
    .number()
    .int('limit must be an integer')
    .positive('limit must be positive')
    .max(HISTORY_MAX_LIMIT, `limit must be ${HISTORY_MAX_LIMIT} or fewer`)
    .default(HISTORY_DEFAULT_LIMIT),
  page: z.coerce
    .number()
    .int('page must be an integer')
    .positive('page must be positive')
    .default(1),
});

const itemIdParamsSchema = z.object({ id: z.string().min(1, 'Media item id is required') });

export const historyRoutes: FastifyPluginAsync = async (app) => {
  const authedOnly = { preHandler: [app.authenticate] };

  // The caller's history, paginated. Access is enforced by scoping to their
  // accessible libraries and applying the parental-controls filter, exactly
  // like the browse feeds.
  app.get('/history', authedOnly, async (request, reply) => {
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'VALIDATION',
        query.error.issues[0]?.message ?? 'Invalid query parameters',
      );
    }

    const libraryIds = await getAccessibleLibraryIds(request.user);
    const ratingFilter = await resolveRatingFilter(request.user);
    return getUserHistory(
      request.user.id,
      libraryIds,
      query.data.page,
      query.data.limit,
      ratingFilter,
    );
  });

  // Remove one item from the caller's history. Access-checked (404 cloak) so an
  // ungranted/nonexistent/over-cap id is indistinguishable; idempotent (clearing
  // an item with no stored state still returns 204).
  app.delete('/history/:id', authedOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const item = await assertMediaItemAccess(request.user, params.id);
    await clearWatchState(request.user.id, item.id);
    return reply.status(204).send();
  });
};
