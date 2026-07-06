import type { User } from '@prisma/client';
import type { FastifyReply } from 'fastify';

/** Access token lifetime. Kept short; the refresh token does the long haul. */
export const ACCESS_TOKEN_TTL = '15m';

/** JWT access token payload. */
export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  role: string;
  username: string;
}

/** Public shape of a user. Never includes passwordHash. */
export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  isEnabled: boolean;
  mustChangePassword: boolean;
  /** Per-user maximum transcode quality, or null for "no personal cap". */
  maxQuality: string | null;
  /**
   * Per-user parental-controls cap: the highest content rating this user may
   * see/stream (a RATING_LADDER name), or null for "no cap" (unrestricted).
   */
  maxContentRating: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

/**
 * How a request authenticated. 'jwt' is a normal access-token session; the
 * others are personal API tokens (auth/api-tokens.ts).
 */
export type AuthMethod = 'jwt' | 'api-token';

/**
 * Effective capability of the authenticated principal. 'full' behaves as the
 * user (still bounded by role + library grants); 'read' is restricted to safe
 * (GET/HEAD) requests. JWT sessions are always 'full'; API tokens carry their
 * stored scope.
 */
export type AuthScope = 'read' | 'full';

export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    isEnabled: user.isEnabled,
    mustChangePassword: user.mustChangePassword,
    maxQuality: user.maxQuality,
    maxContentRating: user.maxContentRating,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    /** Set by the `authenticate` preHandler: a fresh user loaded from the DB. */
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * preHandler that verifies the access token, loads the user from the DB,
     * rejects disabled/deleted users and attaches the user to request.user.
     */
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }

  interface FastifyRequest {
    /**
     * Set by the `authenticate` preHandler once a principal is resolved:
     * 'jwt' for access-token sessions, 'api-token' for personal API tokens.
     * Undefined on unauthenticated requests. Routes that must never be reached
     * with a token (e.g. token management, to stop self-propagation) gate on
     * this.
     */
    authMethod?: AuthMethod;
    /**
     * Effective scope of the authenticated principal: 'full' for JWT sessions
     * and full API tokens, 'read' for read-only API tokens. Undefined on
     * unauthenticated requests.
     */
    authScope?: AuthScope;
  }
}
