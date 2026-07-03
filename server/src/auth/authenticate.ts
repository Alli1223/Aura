import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPrisma } from '../db/client.js';
import { sendError } from '../lib/errors.js';
import { toAuthUser, type AccessTokenPayload } from './types.js';

/**
 * preHandler decorated onto the app as `authenticate`. Verifies the JWT
 * access token, loads a fresh user from the database (so disable/delete take
 * effect immediately) and attaches it as request.user. This is the seam the
 * upcoming RBAC middleware builds on.
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

  request.user = toAuthUser(user);
}
