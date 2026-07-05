import { createReadStream } from 'node:fs';

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { assertMediaItemAccess, ITEM_NOT_FOUND_MESSAGE } from '../auth/access.js';
import type { Config } from '../config.js';
import { notFoundError } from '../lib/errors.js';
import { parseParams } from '../lib/validation.js';
import {
  ARTWORK_SIZES,
  ArtworkError,
  resolveArtwork,
  type ArtworkSize,
} from '../metadata/artwork-cache.js';

// Artwork delivery: GET /api/items/:id/artwork/:kind?size=...
//
// Access control mirrors the rest of the media surface via
// assertMediaItemAccess, whose enumeration cloak means an ungranted item, a
// nonexistent item AND an item with no artwork of the requested kind all
// return a byte-identical 404 NOT_FOUND — a caller can never tell them apart,
// so artwork ids leak nothing about which items exist or are accessible.
//
// The cached file is streamed with a private, one-day Cache-Control and an
// ETag equal to the cache key (sha256 of source+size). A matching
// If-None-Match short-circuits to 304 without touching the cache file.

export interface ImageRoutesOptions {
  config: Config;
}

/** Which artwork a request is asking for and where it lives on the item. */
const ARTWORK_KINDS = ['poster', 'backdrop'] as const;
type ArtworkKind = (typeof ARTWORK_KINDS)[number];

const paramsSchema = z.object({
  id: z.string().min(1, 'Media item id is required'),
  kind: z.enum(ARTWORK_KINDS, { error: 'kind must be one of: poster, backdrop' }),
});

const querySchema = z.object({
  size: z.enum(ARTWORK_SIZES, { error: `size must be one of: ${ARTWORK_SIZES.join(', ')}` }).default('w400'),
});

/** Column on MediaItem backing each artwork kind. */
const KIND_COLUMN: Record<ArtworkKind, 'posterPath' | 'backdropPath'> = {
  poster: 'posterPath',
  backdrop: 'backdropPath',
};

export const imageRoutes: FastifyPluginAsync<ImageRoutesOptions> = async (app, opts) => {
  app.get('/:id/artwork/:kind', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = parseParams(paramsSchema, request.params, reply);
    if (params === undefined) return reply;

    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION', message: query.error.issues[0]?.message ?? 'Invalid size' },
      });
    }
    const size: ArtworkSize = query.data.size;

    // Access + existence in one step; throws the cloaking 404 for missing or
    // ungranted items.
    const item = await assertMediaItemAccess(request.user, params.id);

    const sourceUri = item[KIND_COLUMN[params.kind]];
    if (sourceUri === null || sourceUri === '') {
      // No artwork of this kind → same 404 as missing/ungranted, so the
      // presence of artwork is not observable either.
      throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    }

    let resolved;
    try {
      resolved = await resolveArtwork(sourceUri, size, {
        configDir: opts.config.CONFIG_DIR,
        mediaRoots: opts.config.MEDIA_ROOTS,
      });
    } catch (err) {
      if (err instanceof ArtworkError) {
        // A broken/unreachable/invalid source is, from the client's point of
        // view, artwork that isn't there — keep the cloak uniform.
        throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
      }
      throw err;
    }

    const etag = `"${resolved.cacheKey}"`;
    void reply.header('Cache-Control', 'private, max-age=86400');
    void reply.header('ETag', etag);

    if (request.headers['if-none-match'] === etag) {
      return reply.status(304).send();
    }

    void reply.header('Content-Type', resolved.contentType);
    return reply.send(createReadStream(resolved.filePath));
  });
};
