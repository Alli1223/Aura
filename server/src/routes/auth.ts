import { Prisma, type User } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';

import { getDummyPasswordHash, hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  clearRefreshCookie,
  createRefreshSession,
  hashRefreshToken,
  REFRESH_COOKIE_NAME,
  RefreshTokenReuseError,
  revokeSessionChain,
  rotateRefreshSession,
  setRefreshCookie,
} from '../auth/refresh.js';
import { loginBodySchema, registerBodySchema } from '../auth/schemas.js';
import { toAuthUser } from '../auth/types.js';
import { RATE_LIMIT_TIME_WINDOW, type Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { ApiError, sendError } from '../lib/errors.js';
import { getSetting } from '../lib/settings.js';
import { parseBody } from '../lib/validation.js';

export interface AuthRoutesOptions {
  config: Config;
}

const INVALID_CREDENTIALS_MESSAGE = 'Invalid username or password';
const INVALID_REFRESH_MESSAGE = 'Invalid refresh token';

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();
  const secureCookies = opts.config.NODE_ENV === 'production';

  // Stricter per-route budgets than the global limiter: login/register are
  // credential-guessing surfaces, refresh is hit routinely by every client.
  // No-ops unless the rate limit plugin is registered (RATE_LIMIT_ENABLED).
  const credentialRateLimit = {
    rateLimit: { max: opts.config.RATE_LIMIT_AUTH_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW },
  };
  const refreshRateLimit = {
    rateLimit: { max: opts.config.RATE_LIMIT_REFRESH_MAX, timeWindow: RATE_LIMIT_TIME_WINDOW },
  };

  const signAccessToken = (user: User): string =>
    app.jwt.sign({ sub: user.id, role: user.role, username: user.username });

  app.post('/register', { config: credentialRateLimit }, async (request, reply) => {
    const body = parseBody(registerBodySchema, request.body, reply);
    if (body === undefined) return reply;

    const registrationEnabled = await getSetting('registrationEnabled', request.log);
    const passwordHash = await hashPassword(body.password);

    let user: User;
    try {
      // Count + create in one transaction so two simultaneous first
      // registrations cannot both become admin.
      user = await prisma.$transaction(async (tx) => {
        const userCount = await tx.user.count();
        // First-run exception: with zero users the toggle is ignored so the
        // first admin can always be created. The check lives inside the
        // transaction so it uses the same count as the admin-role decision.
        if (userCount > 0 && !registrationEnabled) {
          throw new ApiError(403, 'REGISTRATION_DISABLED', 'Registration is currently disabled');
        }
        return tx.user.create({
          data: {
            username: body.username,
            email: body.email ?? null,
            passwordHash,
            role: userCount === 0 ? 'admin' : 'user',
          },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = JSON.stringify(err.meta?.target ?? '');
        if (target.includes('email')) {
          return sendError(reply, 409, 'EMAIL_TAKEN', 'Email is already in use');
        }
        return sendError(reply, 409, 'USERNAME_TAKEN', 'Username is already taken');
      }
      throw err;
    }

    await writeAuditLog(
      prisma,
      {
        action: 'user.register',
        userId: user.id,
        ip: request.ip,
        details: { username: user.username, role: user.role },
      },
      request.log,
    );

    const refreshToken = await createRefreshSession(prisma, user.id, request);
    setRefreshCookie(reply, refreshToken, secureCookies);
    return reply.status(201).send({ user: toAuthUser(user), accessToken: signAccessToken(user) });
  });

  app.post('/login', { config: credentialRateLimit }, async (request, reply) => {
    const body = parseBody(loginBodySchema, request.body, reply);
    if (body === undefined) return reply;

    const user = await prisma.user.findUnique({ where: { username: body.username } });
    let passwordOk = false;
    if (user !== null) {
      passwordOk = await verifyPassword(user.passwordHash, body.password);
    } else {
      // Burn a verification so timing does not reveal unknown usernames.
      await verifyPassword(await getDummyPasswordHash(), body.password);
    }

    if (user === null || !passwordOk) {
      await writeAuditLog(
        prisma,
        {
          action: 'auth.login.failure',
          userId: user?.id ?? null,
          ip: request.ip,
          details: { username: body.username },
        },
        request.log,
      );
      return sendError(reply, 401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
    }

    if (!user.isEnabled) {
      await writeAuditLog(
        prisma,
        {
          action: 'auth.login.failure',
          userId: user.id,
          ip: request.ip,
          details: { username: body.username, reason: 'disabled' },
        },
        request.log,
      );
      return sendError(reply, 403, 'ACCOUNT_DISABLED', 'This account is disabled');
    }

    const loggedIn = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await writeAuditLog(
      prisma,
      { action: 'auth.login.success', userId: user.id, ip: request.ip },
      request.log,
    );

    const refreshToken = await createRefreshSession(prisma, user.id, request);
    setRefreshCookie(reply, refreshToken, secureCookies);
    return reply.send({ user: toAuthUser(loggedIn), accessToken: signAccessToken(loggedIn) });
  });

  app.post('/refresh', { config: refreshRateLimit }, async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE_NAME];
    if (token === undefined || token === '') {
      return sendError(reply, 401, 'UNAUTHORIZED', 'Missing refresh token');
    }

    const session = await prisma.refreshSession.findUnique({
      where: { tokenHash: hashRefreshToken(token) },
      include: { user: true },
    });
    if (session === null) {
      clearRefreshCookie(reply, secureCookies);
      return sendError(reply, 401, 'UNAUTHORIZED', INVALID_REFRESH_MESSAGE);
    }

    const reuseDetected = async (): Promise<void> => {
      await revokeSessionChain(prisma, session.id);
      await writeAuditLog(
        prisma,
        {
          action: 'auth.refresh.reuse_detected',
          userId: session.userId,
          ip: request.ip,
          details: { sessionId: session.id },
        },
        request.log,
      );
    };

    if (session.revokedAt !== null) {
      // A revoked token was presented: assume theft, kill the whole chain.
      await reuseDetected();
      clearRefreshCookie(reply, secureCookies);
      return sendError(reply, 401, 'UNAUTHORIZED', INVALID_REFRESH_MESSAGE);
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      clearRefreshCookie(reply, secureCookies);
      return sendError(reply, 401, 'UNAUTHORIZED', INVALID_REFRESH_MESSAGE);
    }

    if (!session.user.isEnabled) {
      clearRefreshCookie(reply, secureCookies);
      return sendError(reply, 403, 'ACCOUNT_DISABLED', 'This account is disabled');
    }

    let newToken: string;
    try {
      newToken = await rotateRefreshSession(prisma, session, request);
    } catch (err) {
      if (err instanceof RefreshTokenReuseError) {
        await reuseDetected();
        clearRefreshCookie(reply, secureCookies);
        return sendError(reply, 401, 'UNAUTHORIZED', INVALID_REFRESH_MESSAGE);
      }
      throw err;
    }

    setRefreshCookie(reply, newToken, secureCookies);
    // Include the safe user shape (with mustChangePassword) so clients can
    // redirect to a forced password change straight after a refresh.
    return reply.send({
      accessToken: signAccessToken(session.user),
      user: toAuthUser(session.user),
    });
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE_NAME];
    if (token !== undefined && token !== '') {
      const session = await prisma.refreshSession.findUnique({
        where: { tokenHash: hashRefreshToken(token) },
      });
      if (session !== null && session.revokedAt === null) {
        await prisma.refreshSession.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });
        await writeAuditLog(
          prisma,
          { action: 'auth.logout', userId: session.userId, ip: request.ip },
          request.log,
        );
      }
    }
    clearRefreshCookie(reply, secureCookies);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: app.authenticate }, async (request) => ({ user: request.user }));
};
