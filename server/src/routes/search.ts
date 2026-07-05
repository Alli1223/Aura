import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getAccessibleLibraryIds } from '../auth/access.js';
import { sendError } from '../lib/errors.js';
import { searchLibraryItems } from '../lib/media-query.js';

// Search API the web app consumes: a single authenticated endpoint that matches
// top-level media items (movies/shows) by title, sortTitle and genre name,
// scoped to the caller's accessible libraries. Access is enforced by only ever
// searching the ids getAccessibleLibraryIds returns (admins: all; users: their
// grants; disabled users: none), so an item in an ungranted library can never
// appear — even on an exact title match. The serialization (safe item shape,
// artwork route, no leaked fs paths, ranking) lives in lib/media-query.ts.
//
// Registered on the /api prefix; the concrete path is /api/search. It does not
// collide with mediaRoutes (/api/libraries, /api/items, /api/home).

const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;

const searchQuerySchema = z.object({
  // An absent or whitespace-only q is not an error: it yields empty results.
  q: z.string().default(''),
  limit: z.coerce
    .number()
    .int('limit must be an integer')
    .positive('limit must be positive')
    .max(SEARCH_LIMIT_MAX, `limit must be ${SEARCH_LIMIT_MAX} or fewer`)
    .default(SEARCH_LIMIT_DEFAULT),
});

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/search', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = searchQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(
        reply,
        400,
        'VALIDATION',
        query.error.issues[0]?.message ?? 'Invalid query parameters',
      );
    }

    const trimmed = query.data.q.trim();
    const libraryIds = await getAccessibleLibraryIds(request.user);
    const results = await searchLibraryItems(
      request.user.id,
      libraryIds,
      trimmed,
      query.data.limit,
    );
    return { results, query: trimmed };
  });
};
