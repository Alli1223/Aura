import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import {
  assertMediaItemAccess,
  getAccessibleLibraryIds,
  resolveRatingFilter,
} from '../auth/access.js';
import { getPrisma } from '../db/client.js';
import { sendError } from '../lib/errors.js';
import { filterContinueWatchingByRating, filterItemIdsByRating } from '../lib/media-query.js';
import { parseBody, parseParams } from '../lib/validation.js';
import {
  getContinueWatching,
  getItemState,
  getStatesForItems,
  markTreeWatched,
  reportProgress,
} from '../lib/watch-state.js';

// Per-user watch progress & watched state. Every route authenticates and
// re-checks library access through the shared helpers, so an ungranted or
// nonexistent item yields the byte-identical cloaking 404 from
// assertMediaItemAccess (see auth/access.ts). No audit here: progress is
// far too high-frequency to log.
//
// Registered on the /api prefix because the routes span /api/items/... and
// /api/continue-watching. No path collides with imageRoutes (also under
// /api/items): those are GET /:id/artwork/:kind only.

/** Maximum ids accepted by the batch state endpoint (grid overlays). */
const MAX_BATCH_IDS = 200;
const CONTINUE_WATCHING_DEFAULT_LIMIT = 20;
const CONTINUE_WATCHING_MAX_LIMIT = 100;

const itemIdParamsSchema = z.object({ id: z.string().min(1, 'Media item id is required') });

const progressBodySchema = z.object({
  // Negative values are accepted and clamped to 0 by the service (a scrub to
  // the very start can report a tiny negative from some players).
  positionMs: z
    .number({ error: 'positionMs must be a number' })
    .int('positionMs must be an integer'),
  durationMs: z
    .number({ error: 'durationMs must be a number' })
    .int('durationMs must be an integer')
    .positive('durationMs must be positive')
    .optional(),
});

const watchedBodySchema = z.object({
  watched: z.boolean({ error: 'watched must be a boolean' }),
});

const stateBatchBodySchema = z.object({
  ids: z
    .array(z.string().min(1, 'Each id must be a non-empty string'), {
      error: 'ids must be an array of media item ids',
    })
    .max(MAX_BATCH_IDS, `A batch may request at most ${MAX_BATCH_IDS} ids`),
});

const continueWatchingQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(CONTINUE_WATCHING_MAX_LIMIT)
    .default(CONTINUE_WATCHING_DEFAULT_LIMIT),
});

export const watchRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const authedOnly = { preHandler: [app.authenticate] };

  // High-frequency: called repeatedly by the player. Kept to two indexed
  // lookups plus an upsert; covered by the global rate limit.
  app.post('/items/:id/progress', authedOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(progressBodySchema, request.body, reply);
    if (body === undefined) return reply;

    const item = await assertMediaItemAccess(request.user, params.id);
    const state = await reportProgress(
      request.user.id,
      item.id,
      body.positionMs,
      body.durationMs ?? item.runtimeMs ?? undefined,
    );
    return { state };
  });

  // Explicit (un)mark. Cascades to descendant episodes for shows/seasons.
  app.put('/items/:id/watched', authedOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(watchedBodySchema, request.body, reply);
    if (body === undefined) return reply;

    const item = await assertMediaItemAccess(request.user, params.id);
    const summary = await markTreeWatched(request.user.id, item.id, body.watched);
    return { summary };
  });

  // Single-item state: derived watched + next-unwatched for containers.
  app.get('/items/:id/state', authedOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const item = await assertMediaItemAccess(request.user, params.id);
    const state = await getItemState(request.user.id, item);
    return { state };
  });

  // Batch state for grid overlays. Inaccessible or nonexistent ids are
  // silently omitted (never 404 the whole batch), so the map never reveals
  // which ids exist in libraries the caller cannot see.
  app.post('/items/state', authedOnly, async (request, reply) => {
    const body = parseBody(stateBatchBodySchema, request.body, reply);
    if (body === undefined) return reply;

    const uniqueIds = [...new Set(body.ids)];
    const accessibleLibraryIds = new Set(await getAccessibleLibraryIds(request.user));
    const items =
      uniqueIds.length === 0
        ? []
        : await prisma.mediaItem.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true, libraryId: true, contentRating: true, parentId: true },
          });
    // Library access AND the parental-controls cap: an over-cap id is dropped
    // from the map exactly like an inaccessible one, so a restricted user's
    // grid overlay never reveals a blocked item's existence or their progress.
    const accessibleItems = items.filter((item) => accessibleLibraryIds.has(item.libraryId));
    const ratingFilter = await resolveRatingFilter(request.user);
    const allowedRatingIds = await filterItemIdsByRating(accessibleItems, ratingFilter);
    const accessibleIds = accessibleItems
      .filter((item) => allowedRatingIds.has(item.id))
      .map((item) => item.id);

    const states = await getStatesForItems(request.user.id, accessibleIds);
    return { states: Object.fromEntries(states) };
  });

  // In-progress items across permitted libraries, most-recent first.
  app.get('/continue-watching', authedOnly, async (request, reply) => {
    const query = continueWatchingQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'VALIDATION',
        query.error.issues[0]?.message ?? 'Invalid query parameters',
      );
    }

    const libraryIds = await getAccessibleLibraryIds(request.user);
    const items = await getContinueWatching(request.user.id, libraryIds, query.data.limit);
    // Parental controls: drop entries whose (effective) rating exceeds the
    // user's cap — e.g. an episode of a now-blocked show, or after a cap change.
    const ratingFilter = await resolveRatingFilter(request.user);
    const visible = await filterContinueWatchingByRating(items, ratingFilter);
    return { items: visible };
  });
};
