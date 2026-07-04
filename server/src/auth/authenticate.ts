import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPrisma } from '../db/client.js';
import { sendError } from '../lib/errors.js';
import { toAuthUser, type AccessTokenPayload } from './types.js';

/**
 * The only authenticated routes a user with mustChangePassword=true may
 * reach: inspecting their own session and actually changing the password
 * (plus logout, which is unauthenticated today but allowlisted so it keeps
 * working if it ever gains the authenticate preHandler). Everything else is
 * rejected with 403 PASSWORD_CHANGE_REQUIRED. Matching is on the method plus
 * the registered route pattern (request.routeOptions.url) so it fails closed:
 * an unknown or unregistered pattern never matches the allowlist.
 */
const PASSWORD_CHANGE_ALLOWED_ROUTES = new Set([
  'GET /api/auth/me',
  'GET /api/users/me',
  'POST /api/users/me/password',
  'POST /api/auth/logout',
]);

/**
 * preHandler decorated onto the app as `authenticate`. Verifies the JWT
 * access token, loads a fresh user from the database (so disable/delete take
 * effect immediately) and attaches it as request.user. This is the seam the
 * RBAC middleware builds on.
 *
 * Users flagged with mustChangePassword are locked down to the small
 * allowlist above until they set a new password.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let payload: AccessTokenPayload;
  try {
    payload = await request.jwtVerify<AccessTokenPayload>();
  } catch {
    sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid access token');
    return;
  }

  const user = await getPrisma().user.findUnique({ where: { id: payload.sub } });
  if (user === null) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid access token');
    return;
  }
  if (!user.isEnabled) {
    sendError(reply, 403, 'ACCOUNT_DISABLED', 'This account is disabled');
    return;
  }

  if (user.mustChangePassword) {
    const route = `${request.method} ${request.routeOptions.url ?? ''}`;
    if (!PASSWORD_CHANGE_ALLOWED_ROUTES.has(route)) {
      sendError(
        reply,
        403,
        'PASSWORD_CHANGE_REQUIRED',
        'You must change your password before continuing',
      );
      return;
    }
  }

  request.user = toAuthUser(user);
}
