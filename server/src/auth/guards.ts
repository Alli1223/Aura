import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { sendError } from '../lib/errors.js';
import { assertLibraryAccess } from './access.js';

// Route-level RBAC guards. Both compose AFTER `authenticate` in a preHandler
// array — they rely on request.user being set:
//
//   app.get('/admin/thing', { preHandler: [app.authenticate, app.requireAdmin] }, ...)
//   app.get('/libraries/:libraryId/items',
//     { preHandler: [app.authenticate, requireLibraryAccess()] }, ...)
//
// Guards are hot paths: no auditing here.

/**
 * preHandler decorated onto the app as `requireAdmin`. Rejects non-admin
 * users with the standard 403 FORBIDDEN error. Returns 401 if it runs
 * without `authenticate` having set request.user (a route wiring bug —
 * fail closed).
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = request.user as FastifyRequest['user'] | undefined;
  if (user === undefined) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid access token');
    return;
  }
  // Defence in depth: authenticate already rejects disabled users.
  if (!user.isEnabled || user.role !== 'admin') {
    sendError(reply, 403, 'FORBIDDEN', 'Administrator access required');
  }
}

/**
 * Factory for a preHandler that enforces library access on routes with a
 * library id path parameter (`:libraryId` by default). Admins pass for any
 * id; users only for granted libraries — the 403 is identical whether the
 * library exists or not.
 */
export function requireLibraryAccess(paramName = 'libraryId'): preHandlerAsyncHookHandler {
  return async function libraryAccessGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const user = request.user as FastifyRequest['user'] | undefined;
    if (user === undefined) {
      sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid access token');
      return;
    }

    const params = request.params as Record<string, unknown>;
    const libraryId = params[paramName];
    if (typeof libraryId !== 'string' || libraryId === '') {
      // The route pattern is missing the parameter — a wiring bug, not a
      // client error. Fail closed with a 500 rather than letting it through.
      throw new Error(`requireLibraryAccess: route has no ":${paramName}" path parameter`);
    }

    await assertLibraryAccess(user, libraryId);
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * preHandler that rejects non-admin users with 403 FORBIDDEN. Must run
     * after `authenticate` (compose: [app.authenticate, app.requireAdmin]).
     */
    requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}
