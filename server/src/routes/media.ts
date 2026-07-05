import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  assertMediaItemAccess,
  canAccessLibrary,
  getAccessibleLibraryIds,
} from '../auth/access.js';
import type { AuthUser } from '../auth/types.js';
import { getPrisma } from '../db/client.js';
import { notFoundError, sendError } from '../lib/errors.js';
import {
  getHomeRecentlyAdded,
  getItemChildren,
  getItemDetail,
  getLibraryRecentlyAdded,
  listLibraryItems,
} from '../lib/media-query.js';
import { parseParams } from '../lib/validation.js';

// Read-only browse API the web app consumes: library listings, item detail,
// container children and recently-added feeds. Every route authenticates and
// is access-checked through the shared helpers, so an ungranted or nonexistent
// library/item yields the byte-identical cloaking 404 (see auth/access.ts).
// The continue-watching feed the home screen also needs lives in watch.ts
// (GET /api/continue-watching) and is intentionally not duplicated here.
//
// Registered on the /api prefix because the routes span /api/libraries/:id/...,
// /api/items/:id/... and /api/home/... . None collide with imageRoutes
// (/api/items/:id/artwork/:kind) or watchRoutes (/api/items/:id/{state,...}).

const LIBRARY_NOT_FOUND_MESSAGE = 'Library not found';

const RECENTLY_ADDED_DEFAULT_LIMIT = 20;
const RECENTLY_ADDED_MAX_LIMIT = 100;
const PAGE_SIZE_DEFAULT = 48;
const PAGE_SIZE_MAX = 100;

const libraryIdParamsSchema = z.object({ id: z.string().min(1, 'Library id is required') });
const itemIdParamsSchema = z.object({ id: z.string().min(1, 'Media item id is required') });

const listQuerySchema = z.object({
  sort: z.enum(['title', 'year', 'added', 'rating']).default('title'),
  order: z.enum(['asc', 'desc']).default('asc'),
  genre: z.string().optional(),
  // An empty `year=` means "no filter" (like genre/search), not year 0: strip
  // it before coercion so `?year=` doesn't silently filter to items with year 0.
  year: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int('year must be an integer').optional(),
  ),
  watched: z.enum(['true', 'false', 'all']).default('all'),
  page: z.coerce
    .number()
    .int('page must be an integer')
    .positive('page must be positive')
    .default(1),
  pageSize: z.coerce
    .number()
    .int('pageSize must be an integer')
    .positive('pageSize must be positive')
    .max(PAGE_SIZE_MAX, `pageSize must be ${PAGE_SIZE_MAX} or fewer`)
    .default(PAGE_SIZE_DEFAULT),
  search: z.string().optional(),
});

const recentlyAddedQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int('limit must be an integer')
    .positive('limit must be positive')
    .max(RECENTLY_ADDED_MAX_LIMIT, `limit must be ${RECENTLY_ADDED_MAX_LIMIT} or fewer`)
    .default(RECENTLY_ADDED_DEFAULT_LIMIT),
});

/** First zod issue message, sent as the standard 400 VALIDATION body. */
function sendValidationError(reply: FastifyReply, issue: string | undefined): FastifyReply {
  return sendError(reply, 400, 'VALIDATION', issue ?? 'Invalid query parameters');
}

/**
 * Enforces the library 404 cloak: a missing library and one the caller has no
 * grant for both throw the byte-identical NOT_FOUND, so a response never
 * reveals whether a library id exists (same stance as GET /api/libraries/:id).
 * The existence check runs for everyone because canAccessLibrary is true for
 * any id for an admin.
 */
async function assertLibraryReadable(user: AuthUser, libraryId: string): Promise<void> {
  const library = await getPrisma().library.findUnique({
    where: { id: libraryId },
    select: { id: true },
  });
  if (library === null || !(await canAccessLibrary(user, libraryId))) {
    throw notFoundError(LIBRARY_NOT_FOUND_MESSAGE);
  }
}

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  const authedOnly = { preHandler: [app.authenticate] };

  // Paginated/sorted/filtered top-level items of a library (poster grid).
  app.get('/libraries/:id/items', authedOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues[0]?.message);

    await assertLibraryReadable(request.user, params.id);
    return listLibraryItems(request.user.id, params.id, query.data);
  });

  // Recently-added top-level items within one library.
  app.get('/libraries/:id/recently-added', authedOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const query = recentlyAddedQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues[0]?.message);

    await assertLibraryReadable(request.user, params.id);
    const items = await getLibraryRecentlyAdded(request.user.id, params.id, query.data.limit);
    return { items };
  });

  // Recently-added top-level items across every permitted library (home row).
  app.get('/home/recently-added', authedOnly, async (request, reply) => {
    const query = recentlyAddedQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues[0]?.message);

    const libraryIds = await getAccessibleLibraryIds(request.user);
    const items = await getHomeRecentlyAdded(request.user.id, libraryIds, query.data.limit);
    return { items };
  });

  // Item detail: movie -> files/streams; show -> seasons; season -> episodes.
  app.get('/items/:id', authedOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const item = await assertMediaItemAccess(request.user, params.id);
    return getItemDetail(request.user.id, item.id);
  });

  // Container children: show -> seasons, season -> episodes, leaf -> empty.
  app.get('/items/:id/children', authedOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const item = await assertMediaItemAccess(request.user, params.id);
    const items = await getItemChildren(request.user.id, item);
    return { items };
  });
};
