import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  assertMediaItemAccess,
  canAccessLibrary,
  getAccessibleLibraryIds,
  resolveRatingFilter,
} from '../auth/access.js';
import type { AuthUser } from '../auth/types.js';
import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { notFoundError, sendError } from '../lib/errors.js';
import {
  getHomeRecentlyAdded,
  getItemChildren,
  getItemDetail,
  getLibraryRecentlyAdded,
  listLibraryItems,
} from '../lib/media-query.js';
import { parseBody, parseParams } from '../lib/validation.js';

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

const ITEM_NOT_FOUND_MESSAGE = 'Media item not found';
const NOT_A_SHOW_MESSAGE = 'Skip config can only be set on a show';

// A show's intro/credits skip offsets (skip-markers). Each field is an optional,
// nullable, non-negative ms offset: a number sets it, `null` clears it, and an
// omitted field is left unchanged on update. At least one must be present, and
// the two credits offsets are mutually exclusive (the absolute start would
// always win over the from-end one, so accepting both would be ambiguous).
const skipConfigBodySchema = z
  .object({
    introEndMs: z.number().int().nonnegative().nullable().optional(),
    creditsStartMs: z.number().int().nonnegative().nullable().optional(),
    creditsFromEndMs: z.number().int().nonnegative().nullable().optional(),
  })
  .refine(
    (body) =>
      body.introEndMs !== undefined ||
      body.creditsStartMs !== undefined ||
      body.creditsFromEndMs !== undefined,
    { message: 'At least one of introEndMs, creditsStartMs or creditsFromEndMs must be provided' },
  )
  .refine((body) => !(body.creditsStartMs != null && body.creditsFromEndMs != null), {
    message: 'Provide only one of creditsStartMs or creditsFromEndMs',
  });

/** The safe skip-config projection returned by the GET/PUT routes. */
interface SerializedSkipConfig {
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsFromEndMs: number | null;
}

function serializeSkipConfig(config: {
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsFromEndMs: number | null;
}): SerializedSkipConfig {
  return {
    introEndMs: config.introEndMs,
    creditsStartMs: config.creditsStartMs,
    creditsFromEndMs: config.creditsFromEndMs,
  };
}

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
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // Paginated/sorted/filtered top-level items of a library (poster grid).
  app.get('/libraries/:id/items', authedOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues[0]?.message);

    await assertLibraryReadable(request.user, params.id);
    const ratingFilter = await resolveRatingFilter(request.user);
    return listLibraryItems(request.user.id, params.id, query.data, ratingFilter);
  });

  // Recently-added top-level items within one library.
  app.get('/libraries/:id/recently-added', authedOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const query = recentlyAddedQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues[0]?.message);

    await assertLibraryReadable(request.user, params.id);
    const ratingFilter = await resolveRatingFilter(request.user);
    const items = await getLibraryRecentlyAdded(
      request.user.id,
      params.id,
      query.data.limit,
      ratingFilter,
    );
    return { items };
  });

  // Recently-added top-level items across every permitted library (home row).
  app.get('/home/recently-added', authedOnly, async (request, reply) => {
    const query = recentlyAddedQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply, query.error.issues[0]?.message);

    const libraryIds = await getAccessibleLibraryIds(request.user);
    const ratingFilter = await resolveRatingFilter(request.user);
    const items = await getHomeRecentlyAdded(
      request.user.id,
      libraryIds,
      query.data.limit,
      ratingFilter,
    );
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

  // ---------------------------------------------------------------------------
  // Admin: per-show intro/credits skip config (skip-markers). Both routes are
  // admin-only (requireAdmin), so no library 404 cloak is needed — an admin can
  // reach every item. A missing item is 404; an existing non-show item is 400.
  // ---------------------------------------------------------------------------

  // Read a show's skip config (null when none has been set).
  app.get('/items/:id/skip-config', adminOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const prisma = getPrisma();
    const item = await prisma.mediaItem.findUnique({
      where: { id: params.id },
      select: { id: true, type: true },
    });
    if (item === null) return sendError(reply, 404, 'NOT_FOUND', ITEM_NOT_FOUND_MESSAGE);
    if (item.type !== 'show') return sendError(reply, 400, 'VALIDATION', NOT_A_SHOW_MESSAGE);
    const config = await prisma.showSkipConfig.findUnique({ where: { showItemId: item.id } });
    return { config: config === null ? null : serializeSkipConfig(config) };
  });

  // Set/clear a show's skip offsets. Upserts the ShowSkipConfig row; only the
  // provided fields change (an omitted field is left as-is, `null` clears it).
  app.put('/items/:id/skip-config', adminOnly, async (request, reply) => {
    const params = parseParams(itemIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(skipConfigBodySchema, request.body, reply);
    if (body === undefined) return reply;

    const prisma = getPrisma();
    const item = await prisma.mediaItem.findUnique({
      where: { id: params.id },
      select: { id: true, type: true },
    });
    if (item === null) return sendError(reply, 404, 'NOT_FOUND', ITEM_NOT_FOUND_MESSAGE);
    if (item.type !== 'show') return sendError(reply, 400, 'VALIDATION', NOT_A_SHOW_MESSAGE);

    const config = await prisma.showSkipConfig.upsert({
      where: { showItemId: item.id },
      // On create an omitted field defaults to null (the row starts unset).
      create: {
        showItemId: item.id,
        introEndMs: body.introEndMs ?? null,
        creditsStartMs: body.creditsStartMs ?? null,
        creditsFromEndMs: body.creditsFromEndMs ?? null,
      },
      // On update `undefined` fields are skipped by Prisma, so an omitted field
      // is preserved while `null` clears it.
      update: {
        introEndMs: body.introEndMs,
        creditsStartMs: body.creditsStartMs,
        creditsFromEndMs: body.creditsFromEndMs,
      },
    });

    await writeAuditLog(
      prisma,
      {
        action: 'skip_config.updated',
        userId: request.user.id,
        targetType: 'media_item',
        targetId: item.id,
        ip: request.ip,
        details: {
          introEndMs: config.introEndMs,
          creditsStartMs: config.creditsStartMs,
          creditsFromEndMs: config.creditsFromEndMs,
        },
      },
      request.log,
    );

    return reply.send({ config: serializeSkipConfig(config) });
  });
};
