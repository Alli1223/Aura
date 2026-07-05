import type { FastifyReply, FastifyRequest } from 'fastify';

import { getPrisma } from '../db/client.js';
import { sendError } from '../lib/errors.js';
import { isApiToken, touchApiTokenLastUsed, verifyApiToken } from './api-tokens.js';
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

/** Safe HTTP methods a read-only API token may use. */
const READ_ONLY_ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/**
 * Extracts a raw API token from the request, or null when none is presented.
 * Two carriers are accepted:
 *   - `X-Api-Token: aura_...` (dedicated header; any non-empty value routes to
 *     the API-token path so a malformed token fails as an API token, not a JWT)
 *   - `Authorization: Bearer aura_...` (only when the bearer value has the
 *     `aura_` prefix; a normal JWT bearer is left to the JWT path)
 */
function extractApiToken(request: FastifyRequest): string | null {
  const headerToken = request.headers['x-api-token'];
  if (typeof headerToken === 'string' && headerToken.length > 0) return headerToken;

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const bearer = authorization.slice('Bearer '.length);
    if (isApiToken(bearer)) return bearer;
  }
  return null;
}

/**
 * Authenticates a request presenting a personal API token. Loads the fresh
 * owning user (so disable/delete take effect immediately), enforces the token
 * scope, and attaches request.user / request.authScope / request.authMethod.
 *
 * Rejections:
 *   - unknown/revoked/expired token, or a token whose owner is disabled -> 401
 *     (a generic UNAUTHORIZED; API clients get no signal about account state)
 *   - owner has mustChangePassword set -> 403 PASSWORD_CHANGE_REQUIRED (API
 *     tokens are unusable until the password is changed via an interactive
 *     session; there is no allowlist for tokens)
 *   - read-only token on a non-GET/HEAD request -> 403 READ_ONLY_TOKEN
 */
async function authenticateApiToken(
  request: FastifyRequest,
  reply: FastifyReply,
  rawToken: string,
): Promise<void> {
  const prisma = getPrisma();
  const verified = await verifyApiToken(prisma, rawToken);
  if (verified === null) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid API token');
    return;
  }

  const { user, scope, tokenId } = verified;
  // Disabled (and, via cascade delete, missing) owners cannot use their
  // tokens. Kept as a generic 401 so a token never reveals account state.
  if (!user.isEnabled) {
    sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid API token');
    return;
  }
  if (user.mustChangePassword) {
    sendError(
      reply,
      403,
      'PASSWORD_CHANGE_REQUIRED',
      'You must change your password before continuing',
    );
    return;
  }
  if (scope === 'read' && !READ_ONLY_ALLOWED_METHODS.has(request.method)) {
    sendError(reply, 403, 'READ_ONLY_TOKEN', 'This API token is read-only');
    return;
  }

  request.user = toAuthUser(user);
  request.authMethod = 'api-token';
  request.authScope = scope;
  // Fire-and-forget: recording usage must never block or fail the request.
  touchApiTokenLastUsed(prisma, tokenId, request.log);
}

/**
 * preHandler decorated onto the app as `authenticate`. A request may present
 * either a JWT access token (Authorization: Bearer <jwt>) OR a personal API
 * token (X-Api-Token, or Authorization: Bearer aura_...). API tokens are
 * handled first when detected; otherwise the JWT path runs.
 *
 * The JWT path verifies the access token, loads a fresh user from the database
 * (so disable/delete take effect immediately) and attaches it as request.user.
 * Users flagged with mustChangePassword are locked down to the small allowlist
 * above until they set a new password.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const rawApiToken = extractApiToken(request);
  if (rawApiToken !== null) {
    await authenticateApiToken(request, reply, rawApiToken);
    return;
  }

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
  request.authMethod = 'jwt';
  request.authScope = 'full';
}
