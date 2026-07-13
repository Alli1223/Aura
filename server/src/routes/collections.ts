import { createReadStream } from 'node:fs';

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import {
  COLLECTION_NOT_FOUND_MESSAGE,
  getCollectionDetail,
  getCollectionSummary,
  listVisibleCollections,
  resolveCollectionPosterSource,
} from '../lib/collections.js';
import { notFoundError, sendError } from '../lib/errors.js';
import { parseBody, parseParams } from '../lib/validation.js';
import { ARTWORK_SIZES, ArtworkError, resolveArtwork, type ArtworkSize } from '../metadata/artwork-cache.js';
import { toSortTitle } from '../scanner/scan.js';

// Collections API: manual (admin-curated) groupings of media items plus the
// auto-collections the TMDB agent links from a movie's `belongs_to_collection`.
//
// Reads (GET) are available to every authenticated user but gated by the
// visibility rule in lib/collections.ts: a caller only ever sees a collection
// that has ≥1 member in a library they can access AND that passes their
// parental filter, and only the accessible members are listed/counted. Unknown
// and invisible ids both answer with the byte-identical cloaking 404, exactly
// like the rest of the media surface.
//
// Writes (POST/PATCH/DELETE + membership) are admin only ([authenticate,
// requireAdmin]); they audit collection.created/updated/deleted. Membership and
// ordering are edited through the /:id/items sub-routes.
//
// Registered on the /api/collections prefix; the poster route needs `config`
// for the artwork cache dir + media roots.

export interface CollectionRoutesOptions {
  config: Config;
}

const MEDIA_ITEM_NOT_FOUND_MESSAGE = 'Media item not found';

const idParamsSchema = z.object({ id: z.string().min(1, 'Collection id is required') });

const itemParamsSchema = z.object({
  id: z.string().min(1, 'Collection id is required'),
  mediaItemId: z.string().min(1, 'Media item id is required'),
});

const nameSchema = z
  .string('Collection name is required')
  .trim()
  .min(1, 'Collection name is required')
  .max(200, 'Collection name must be 200 characters or fewer');

const overviewSchema = z
  .string()
  .trim()
  .max(5000, 'Overview must be 5000 characters or fewer');

const createSchema = z.object({
  name: nameSchema,
  overview: overviewSchema.optional(),
});

const updateSchema = z
  .object({
    name: nameSchema.optional(),
    // null clears the overview; a string sets it.
    overview: overviewSchema.nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.overview !== undefined, {
    message: 'At least one of name or overview must be provided',
  });

const addItemSchema = z.object({
  mediaItemId: z.string().min(1, 'mediaItemId is required'),
});

const reorderSchema = z.object({
  orderedItemIds: z
    .array(z.string().min(1, 'Each id must be a non-empty string'))
    .min(1, 'orderedItemIds must not be empty'),
});

const posterQuerySchema = z.object({
  size: z
    .enum(ARTWORK_SIZES, { error: `size must be one of: ${ARTWORK_SIZES.join(', ')}` })
    .default('w400'),
});

export const collectionRoutes: FastifyPluginAsync<CollectionRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();
  const authedOnly = { preHandler: [app.authenticate] };
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // ---- Reads (any authenticated user, visibility-gated) -------------------

  // Collections visible to the caller, each with a poster + accessible count.
  app.get('/', authedOnly, async (request) => {
    const collections = await listVisibleCollections(request.user);
    return { collections };
  });

  // One collection + its accessible members serialized in curated order.
  app.get('/:id', authedOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    return getCollectionDetail(request.user, params.id);
  });

  // The collection's poster image (own art, else the first member's).
  app.get('/:id/poster', authedOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const query = posterQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, 'VALIDATION', query.error.issues[0]?.message ?? 'Invalid size');
    }
    const size: ArtworkSize = query.data.size;

    // null covers unknown, invisible AND poster-less: the same cloaking 404.
    const sourceUri = await resolveCollectionPosterSource(request.user, params.id);
    if (sourceUri === null) throw notFoundError(COLLECTION_NOT_FOUND_MESSAGE);

    let resolved;
    try {
      resolved = await resolveArtwork(sourceUri, size, {
        configDir: opts.config.CONFIG_DIR,
        mediaRoots: opts.config.MEDIA_ROOTS,
      });
    } catch (err) {
      if (err instanceof ArtworkError) throw notFoundError(COLLECTION_NOT_FOUND_MESSAGE);
      throw err;
    }

    const etag = `"${resolved.cacheKey}"`;
    void reply.header('Cache-Control', 'private, max-age=86400');
    void reply.header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.status(304).send();
    void reply.header('Content-Type', resolved.contentType);
    return reply.send(createReadStream(resolved.filePath));
  });

  // ---- Writes (admin only) ------------------------------------------------

  // Create a manual collection.
  app.post('/', adminOnly, async (request, reply) => {
    const body = parseBody(createSchema, request.body, reply);
    if (body === undefined) return reply;

    const created = await prisma.collection.create({
      data: {
        name: body.name,
        sortName: toSortTitle(body.name),
        overview: body.overview ?? null,
        source: 'manual',
      },
    });

    await writeAuditLog(
      prisma,
      {
        action: 'collection.created',
        userId: request.user.id,
        targetType: 'collection',
        targetId: created.id,
        ip: request.ip,
        details: { name: created.name },
      },
      request.log,
    );

    const collection = await getCollectionSummary(request.user, created.id);
    return reply.status(201).send({ collection });
  });

  // Rename / re-describe a collection.
  app.patch('/:id', adminOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(updateSchema, request.body, reply);
    if (body === undefined) return reply;

    const existing = await prisma.collection.findUnique({ where: { id: params.id } });
    if (existing === null) {
      return sendError(reply, 404, 'NOT_FOUND', COLLECTION_NOT_FOUND_MESSAGE);
    }

    const data: { name?: string; sortName?: string; overview?: string | null } = {};
    if (body.name !== undefined) {
      data.name = body.name;
      data.sortName = toSortTitle(body.name);
    }
    if (body.overview !== undefined) data.overview = body.overview;

    await prisma.collection.update({ where: { id: existing.id }, data });

    await writeAuditLog(
      prisma,
      {
        action: 'collection.updated',
        userId: request.user.id,
        targetType: 'collection',
        targetId: existing.id,
        ip: request.ip,
        details: {
          ...(data.name === undefined || data.name === existing.name
            ? {}
            : { name: { from: existing.name, to: data.name } }),
          ...(body.overview === undefined ? {} : { overview: 'changed' }),
        },
      },
      request.log,
    );

    const collection = await getCollectionSummary(request.user, existing.id);
    return reply.send({ collection });
  });

  // Delete a collection (memberships cascade away).
  app.delete('/:id', adminOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const existing = await prisma.collection.findUnique({ where: { id: params.id } });
    if (existing === null) {
      return sendError(reply, 404, 'NOT_FOUND', COLLECTION_NOT_FOUND_MESSAGE);
    }

    await prisma.collection.delete({ where: { id: existing.id } });

    await writeAuditLog(
      prisma,
      {
        action: 'collection.deleted',
        userId: request.user.id,
        targetType: 'collection',
        targetId: existing.id,
        ip: request.ip,
        details: { name: existing.name, source: existing.source },
      },
      request.log,
    );

    return reply.status(204).send();
  });

  // ---- Membership (admin only) --------------------------------------------

  // Add a media item to a collection (idempotent; appended at the end).
  app.post('/:id/items', adminOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(addItemSchema, request.body, reply);
    if (body === undefined) return reply;

    const collection = await prisma.collection.findUnique({ where: { id: params.id } });
    if (collection === null) {
      return sendError(reply, 404, 'NOT_FOUND', COLLECTION_NOT_FOUND_MESSAGE);
    }
    const item = await prisma.mediaItem.findUnique({
      where: { id: body.mediaItemId },
      select: { id: true },
    });
    if (item === null) {
      return sendError(reply, 404, 'NOT_FOUND', MEDIA_ITEM_NOT_FOUND_MESSAGE);
    }

    const already = await prisma.collectionItem.findUnique({
      where: { collectionId_mediaItemId: { collectionId: collection.id, mediaItemId: item.id } },
      select: { id: true },
    });
    let created = false;
    if (already === null) {
      const max = await prisma.collectionItem.aggregate({
        where: { collectionId: collection.id },
        _max: { order: true },
      });
      await prisma.collectionItem.create({
        data: {
          collectionId: collection.id,
          mediaItemId: item.id,
          order: (max._max.order ?? -1) + 1,
        },
      });
      created = true;
      await writeAuditLog(
        prisma,
        {
          action: 'collection.updated',
          userId: request.user.id,
          targetType: 'collection',
          targetId: collection.id,
          ip: request.ip,
          details: { itemAdded: item.id },
        },
        request.log,
      );
    }

    const summary = await getCollectionSummary(request.user, collection.id);
    return reply.status(created ? 201 : 200).send({ collection: summary });
  });

  // Remove a media item from a collection (idempotent).
  app.delete('/:id/items/:mediaItemId', adminOnly, async (request, reply) => {
    const params = parseParams(itemParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const collection = await prisma.collection.findUnique({ where: { id: params.id } });
    if (collection === null) {
      return sendError(reply, 404, 'NOT_FOUND', COLLECTION_NOT_FOUND_MESSAGE);
    }

    const removed = await prisma.collectionItem.deleteMany({
      where: { collectionId: collection.id, mediaItemId: params.mediaItemId },
    });
    if (removed.count > 0) {
      await writeAuditLog(
        prisma,
        {
          action: 'collection.updated',
          userId: request.user.id,
          targetType: 'collection',
          targetId: collection.id,
          ip: request.ip,
          details: { itemRemoved: params.mediaItemId },
        },
        request.log,
      );
    }

    return reply.status(204).send();
  });

  // Reorder a collection's members. `orderedItemIds` must be exactly the
  // collection's current member ids (a permutation), applied as the new order.
  app.put('/:id/items', adminOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(reorderSchema, request.body, reply);
    if (body === undefined) return reply;

    const collection = await prisma.collection.findUnique({ where: { id: params.id } });
    if (collection === null) {
      return sendError(reply, 404, 'NOT_FOUND', COLLECTION_NOT_FOUND_MESSAGE);
    }

    const members = await prisma.collectionItem.findMany({
      where: { collectionId: collection.id },
      select: { mediaItemId: true },
    });
    const memberIds = new Set(members.map((entry) => entry.mediaItemId));
    const requested = body.orderedItemIds;
    const uniqueRequested = new Set(requested);
    const sameSize =
      uniqueRequested.size === requested.length &&
      requested.length === memberIds.size &&
      requested.every((id) => memberIds.has(id));
    if (!sameSize) {
      return sendError(
        reply,
        400,
        'VALIDATION',
        "orderedItemIds must list exactly the collection's current items",
      );
    }

    await prisma.$transaction(
      requested.map((mediaItemId, index) =>
        prisma.collectionItem.update({
          where: { collectionId_mediaItemId: { collectionId: collection.id, mediaItemId } },
          data: { order: index },
        }),
      ),
    );

    await writeAuditLog(
      prisma,
      {
        action: 'collection.updated',
        userId: request.user.id,
        targetType: 'collection',
        targetId: collection.id,
        ip: request.ip,
        details: { reordered: requested.length },
      },
      request.log,
    );

    return getCollectionDetail(request.user, collection.id);
  });
};
