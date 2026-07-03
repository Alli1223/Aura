import type { User } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
  createdAt: Date;
  lastLoginAt: Date | null;
}

export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    isEnabled: user.isEnabled,
    mustChangePassword: user.mustChangePassword,
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
}
