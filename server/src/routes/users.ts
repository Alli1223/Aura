import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { emailSchema, passwordSchema } from '../auth/schemas.js';
import { toAuthUser } from '../auth/types.js';
import { getPrisma } from '../db/client.js';
import { userRoleSchema } from '../db/constants.js';
import { writeAuditLog } from '../lib/audit.js';
import { ApiError, notFoundError, sendError } from '../lib/errors.js';
import { parseBody, parseParams } from '../lib/validation.js';

// User administration (admin only) and self-service profile routes.
//
// Admin routes compose [authenticate, requireAdmin]; self-service routes
// compose [authenticate] only. All responses use the safe user shape from
// toAuthUser — passwordHash never leaves the database layer.
//
// Safety rails (all 409 CONFLICT):
// - LAST_ADMIN:        cannot demote, disable or delete the last enabled
//                      admin (counted inside the mutating transaction).
// - CANNOT_MODIFY_SELF / CANNOT_DELETE_SELF: admins cannot demote, disable
//                      or delete their own account (lockout footguns).
// - EMAIL_TAKEN:       email uniqueness violations.

const USER_NOT_FOUND_MESSAGE = 'User not found';
const EMAIL_TAKEN_MESSAGE = 'Email is already in use';

const userIdParamsSchema = z.object({ id: z.string().min(1, 'User id is required') });

const adminUpdateUserSchema = z
  .object({
    role: userRoleSchema.optional(),
    isEnabled: z.boolean('isEnabled must be a boolean').optional(),
    email: emailSchema.nullable().optional(),
  })
  .refine(
    (body) => body.role !== undefined || body.isEnabled !== undefined || body.email !== undefined,
    { message: 'At least one of role, isEnabled or email must be provided' },
  );

const adminSetPasswordSchema = z.object({ newPassword: passwordSchema });

const updateProfileSchema = z.object({ email: emailSchema.nullable() });

const changeOwnPasswordSchema = z.object({
  currentPassword: z.string('Current password is required').min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

function isEmailUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    JSON.stringify(err.meta?.target ?? '').includes('email')
  );
}

/** Revokes every active refresh session of a user (logs out all devices). */
function revokeAllSessions(tx: Prisma.TransactionClient, userId: string) {
  return tx.refreshSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Throws 409 LAST_ADMIN unless at least one OTHER enabled admin would remain
 * after removing `target` from the enabled-admin pool. Must run inside the
 * transaction that applies the mutation so concurrent demotions cannot race
 * past the check.
 */
async function assertNotLastEnabledAdmin(
  tx: Prisma.TransactionClient,
  target: User,
  action: string,
): Promise<void> {
  if (target.role !== 'admin' || !target.isEnabled) return;
  const enabledAdmins = await tx.user.count({ where: { role: 'admin', isEnabled: true } });
  if (enabledAdmins <= 1) {
    throw new ApiError(409, 'LAST_ADMIN', `Cannot ${action} the last enabled administrator`);
  }
}

async function loadTargetUser(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<User | undefined> {
  const params = parseParams(userIdParamsSchema, request.params, reply);
  if (params === undefined) return undefined;
  const target = await prisma.user.findUnique({ where: { id: params.id } });
  if (target === null) {
    sendError(reply, 404, 'NOT_FOUND', USER_NOT_FOUND_MESSAGE);
    return undefined;
  }
  return target;
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };
  const selfOnly = { preHandler: [app.authenticate] };

  // -------------------------------------------------------------------------
  // Self-service routes. Registered on the same prefix as the admin routes;
  // the static /me segment always wins over the parametric /:id match.
  // -------------------------------------------------------------------------

  app.get('/me', selfOnly, async (request) => ({ user: request.user }));

  app.patch('/me', selfOnly, async (request, reply) => {
    const body = parseBody(updateProfileSchema, request.body, reply);
    if (body === undefined) return reply;

    let updated: User;
    try {
      updated = await prisma.user.update({
        where: { id: request.user.id },
        data: { email: body.email },
      });
    } catch (err) {
      if (isEmailUniqueViolation(err)) {
        return sendError(reply, 409, 'EMAIL_TAKEN', EMAIL_TAKEN_MESSAGE);
      }
      throw err;
    }

    if (updated.email !== request.user.email) {
      await writeAuditLog(
        prisma,
        {
          action: 'user.email_changed',
          userId: request.user.id,
          targetType: 'user',
          targetId: request.user.id,
          ip: request.ip,
          details: { from: request.user.email, to: updated.email },
        },
        request.log,
      );
    }

    return reply.send({ user: toAuthUser(updated) });
  });

  // Change own password. Revokes ALL refresh sessions, logging every device
  // out; the access token used for this request stays valid until it expires
  // (up to ACCESS_TOKEN_TTL) — accepted trade-off of stateless access tokens.
  app.post('/me/password', selfOnly, async (request, reply) => {
    const body = parseBody(changeOwnPasswordSchema, request.body, reply);
    if (body === undefined) return reply;

    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (user === null) {
      return sendError(reply, 401, 'UNAUTHORIZED', 'Missing or invalid access token');
    }
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      return sendError(reply, 401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }

    const passwordHash = await hashPassword(body.newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      });
      await revokeAllSessions(tx, user.id);
    });

    await writeAuditLog(
      prisma,
      {
        action: 'user.password_changed',
        userId: user.id,
        targetType: 'user',
        targetId: user.id,
        ip: request.ip,
      },
      request.log,
    );

    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // Admin routes
  // -------------------------------------------------------------------------

  app.get('/', adminOnly, async () => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return { users: users.map(toAuthUser) };
  });

  app.get('/:id', adminOnly, async (request, reply) => {
    const target = await loadTargetUser(prisma, request, reply);
    if (target === undefined) return reply;
    return { user: toAuthUser(target) };
  });

  app.patch('/:id', adminOnly, async (request, reply) => {
    const body = parseBody(adminUpdateUserSchema, request.body, reply);
    if (body === undefined) return reply;
    const target = await loadTargetUser(prisma, request, reply);
    if (target === undefined) return reply;

    const actor = request.user;
    const isSelf = target.id === actor.id;
    const demoting = body.role === 'user' && target.role === 'admin';
    const disabling = body.isEnabled === false && target.isEnabled;
    const enabling = body.isEnabled === true && !target.isEnabled;

    let updated: User;
    try {
      updated = await prisma.$transaction(async (tx) => {
        if (demoting || disabling) {
          // LAST_ADMIN outranks the self rails: with a single enabled admin
          // the fundamental problem is admin continuity, not self-editing.
          await assertNotLastEnabledAdmin(tx, target, demoting ? 'demote' : 'disable');
        }
        if (isSelf && demoting) {
          throw new ApiError(409, 'CANNOT_MODIFY_SELF', 'You cannot change your own role');
        }
        if (isSelf && disabling) {
          throw new ApiError(409, 'CANNOT_MODIFY_SELF', 'You cannot disable your own account');
        }

        const user = await tx.user.update({
          where: { id: target.id },
          data: {
            ...(body.role !== undefined ? { role: body.role } : {}),
            ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
            ...(body.email !== undefined ? { email: body.email } : {}),
          },
        });
        // Disabling a user kills all their refresh sessions immediately.
        if (disabling) await revokeAllSessions(tx, target.id);
        return user;
      });
    } catch (err) {
      if (isEmailUniqueViolation(err)) {
        return sendError(reply, 409, 'EMAIL_TAKEN', EMAIL_TAKEN_MESSAGE);
      }
      throw err;
    }

    const auditBase = {
      userId: actor.id,
      targetType: 'user',
      targetId: target.id,
      ip: request.ip,
    };
    if (body.role !== undefined && body.role !== target.role) {
      await writeAuditLog(
        prisma,
        {
          ...auditBase,
          action: 'user.role_changed',
          details: { from: target.role, to: body.role },
        },
        request.log,
      );
    }
    if (disabling || enabling) {
      await writeAuditLog(
        prisma,
        { ...auditBase, action: disabling ? 'user.disabled' : 'user.enabled' },
        request.log,
      );
    }
    if (body.email !== undefined && body.email !== target.email) {
      await writeAuditLog(
        prisma,
        {
          ...auditBase,
          action: 'user.email_changed',
          details: { from: target.email, to: body.email },
        },
        request.log,
      );
    }

    return reply.send({ user: toAuthUser(updated) });
  });

  // Admin sets a temporary password. The target must change it on next login
  // (mustChangePassword) unless the admin is resetting their own password,
  // and every refresh session of the target is revoked.
  app.post('/:id/password', adminOnly, async (request, reply) => {
    const body = parseBody(adminSetPasswordSchema, request.body, reply);
    if (body === undefined) return reply;
    const target = await loadTargetUser(prisma, request, reply);
    if (target === undefined) return reply;

    const isSelf = target.id === request.user.id;
    const passwordHash = await hashPassword(body.newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: { passwordHash, ...(isSelf ? {} : { mustChangePassword: true }) },
      });
      await revokeAllSessions(tx, target.id);
    });

    await writeAuditLog(
      prisma,
      {
        action: 'user.password_reset_by_admin',
        userId: request.user.id,
        targetType: 'user',
        targetId: target.id,
        ip: request.ip,
        details: { username: target.username, mustChangePassword: !isSelf },
      },
      request.log,
    );

    return reply.status(204).send();
  });

  app.delete('/:id', adminOnly, async (request, reply) => {
    const params = parseParams(userIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const actor = request.user;

    const deleted = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: params.id } });
      if (target === null) throw notFoundError(USER_NOT_FOUND_MESSAGE);
      await assertNotLastEnabledAdmin(tx, target, 'delete');
      if (target.id === actor.id) {
        throw new ApiError(409, 'CANNOT_DELETE_SELF', 'You cannot delete your own account');
      }
      // Cascades remove refresh sessions, library grants and watch states.
      await tx.user.delete({ where: { id: target.id } });
      return target;
    });

    await writeAuditLog(
      prisma,
      {
        action: 'user.deleted',
        userId: actor.id,
        targetType: 'user',
        targetId: deleted.id,
        ip: request.ip,
        details: { username: deleted.username, role: deleted.role },
      },
      request.log,
    );

    return reply.status(204).send();
  });
};
