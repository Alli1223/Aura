import { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { ApiError, notFoundError, sendError } from '../lib/errors.js';
import { parseBody, parseParams } from '../lib/validation.js';

// Library access grant management (admin only) — the management API for THE
// access-control pivot (LibraryAccess). Enforcement lives in auth/access.ts;
// these routes only create/remove grant rows, which enforcement re-reads from
// the database on every request, so changes take effect immediately.
//
// Registered under the /api prefix (not /api/access) because the routes span
// three resource scopes:
//   GET    /api/access                          — full user x library matrix
//   PUT    /api/users/:id/libraries             — bulk-replace a user's grants
//   POST   /api/libraries/:id/access            — grant one user
//   DELETE /api/libraries/:id/access/:userId    — revoke one user
//   GET    /api/libraries/:id/access            — users granted to a library
//
// Semantics:
// - Grants to admin-role users are ALLOWED. They are harmless today (admins
//   implicitly access every library) but become meaningful the moment the
//   user is demoted to a regular user — the grants define what they keep.
// - Single grant/revoke are idempotent: granting an existing grant or
//   revoking a non-grant is a 204 no-op with no duplicate row and no audit.
// - These routes are admin only, so unlike the user-facing library routes
//   there is no enumeration concern: unknown ids get plain 404s (or 400
//   UNKNOWN_LIBRARY for bulk bodies) that name the problem.
// - Audit actions: access.bulk_set / access.granted / access.revoked, all
//   with targetType "user" (the semantic subject is the user's access), and
//   only written when something actually changed.

const USER_NOT_FOUND_MESSAGE = 'User not found';
const LIBRARY_NOT_FOUND_MESSAGE = 'Library not found';

const userIdParamsSchema = z.object({ id: z.string().min(1, 'User id is required') });
const libraryIdParamsSchema = z.object({ id: z.string().min(1, 'Library id is required') });
const revokeParamsSchema = z.object({
  id: z.string().min(1, 'Library id is required'),
  userId: z.string().min(1, 'User id is required'),
});

const setUserLibrariesSchema = z.object({
  libraryIds: z.array(
    z.string('Each library id must be a string').min(1, 'Library ids must not be empty'),
    { error: 'libraryIds must be an array of library ids' },
  ),
});

const grantAccessSchema = z.object({
  userId: z.string('userId is required').min(1, 'userId is required'),
});

export const accessRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // Full grant matrix for the admin UI: every user (with their granted
  // library ids) and every library. Selects only safe user fields —
  // passwordHash never leaves the database layer.
  app.get('/access', adminOnly, async () => {
    const [users, libraries] = await Promise.all([
      prisma.user.findMany({
        orderBy: { username: 'asc' },
        select: {
          id: true,
          username: true,
          role: true,
          isEnabled: true,
          libraryAccess: { select: { libraryId: true } },
        },
      }),
      prisma.library.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, type: true },
      }),
    ]);
    return {
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        isEnabled: user.isEnabled,
        libraryIds: user.libraryAccess.map((grant) => grant.libraryId).sort(),
      })),
      libraries,
    };
  });

  // Bulk-REPLACE a user's grants: the body is the desired complete set (an
  // empty array revokes everything). Validation and the add/remove diff run
  // inside one transaction so an UNKNOWN_LIBRARY failure can never leave
  // partial writes, and only the diff is touched (existing grants keep their
  // original grantedAt/grantedById).
  app.put('/users/:id/libraries', adminOnly, async (request, reply) => {
    const params = parseParams(userIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(setUserLibrariesSchema, request.body, reply);
    if (body === undefined) return reply;

    const actor = request.user;
    // Duplicates in the body are harmless — the set is what matters.
    const requestedIds = [...new Set(body.libraryIds)];

    const { added, removed } = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: params.id },
        select: { id: true },
      });
      if (target === null) throw notFoundError(USER_NOT_FOUND_MESSAGE);

      const known = await tx.library.findMany({
        where: { id: { in: requestedIds } },
        select: { id: true },
      });
      if (known.length !== requestedIds.length) {
        const knownIds = new Set(known.map((library) => library.id));
        const unknown = requestedIds.filter((id) => !knownIds.has(id));
        throw new ApiError(400, 'UNKNOWN_LIBRARY', `Unknown library ids: ${unknown.join(', ')}`);
      }

      const current = await tx.libraryAccess.findMany({
        where: { userId: target.id },
        select: { libraryId: true },
      });
      const currentIds = new Set(current.map((grant) => grant.libraryId));
      const requestedSet = new Set(requestedIds);
      const added = requestedIds.filter((id) => !currentIds.has(id)).sort();
      const removed = [...currentIds].filter((id) => !requestedSet.has(id)).sort();

      if (removed.length > 0) {
        await tx.libraryAccess.deleteMany({
          where: { userId: target.id, libraryId: { in: removed } },
        });
      }
      if (added.length > 0) {
        await tx.libraryAccess.createMany({
          data: added.map((libraryId) => ({
            userId: target.id,
            libraryId,
            grantedById: actor.id,
          })),
        });
      }
      return { added, removed };
    });

    if (added.length > 0 || removed.length > 0) {
      await writeAuditLog(
        prisma,
        {
          action: 'access.bulk_set',
          userId: actor.id,
          targetType: 'user',
          targetId: params.id,
          ip: request.ip,
          details: { added, removed },
        },
        request.log,
      );
    }

    return reply.send({ libraryIds: [...requestedIds].sort() });
  });

  // Users granted to a library, with who granted them. `grantedBy` is null
  // when the grant predates tracking or the granting admin was since deleted
  // (LibraryAccess.grantedById is SetNull on user delete).
  app.get('/libraries/:id/access', adminOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const library = await prisma.library.findUnique({
      where: { id: params.id },
      select: { id: true },
    });
    if (library === null) {
      return sendError(reply, 404, 'NOT_FOUND', LIBRARY_NOT_FOUND_MESSAGE);
    }

    const grants = await prisma.libraryAccess.findMany({
      where: { libraryId: library.id },
      select: {
        grantedAt: true,
        user: { select: { id: true, username: true } },
        grantedBy: { select: { username: true } },
      },
      orderBy: { user: { username: 'asc' } },
    });
    return {
      users: grants.map((grant) => ({
        id: grant.user.id,
        username: grant.user.username,
        grantedAt: grant.grantedAt,
        grantedBy: grant.grantedBy?.username ?? null,
      })),
    };
  });

  // Grant one user access to one library. Idempotent: an existing grant is a
  // 204 no-op (no duplicate row, no audit) — including when a concurrent
  // request wins the race to create it.
  app.post('/libraries/:id/access', adminOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(grantAccessSchema, request.body, reply);
    if (body === undefined) return reply;

    const library = await prisma.library.findUnique({
      where: { id: params.id },
      select: { id: true },
    });
    if (library === null) {
      return sendError(reply, 404, 'NOT_FOUND', LIBRARY_NOT_FOUND_MESSAGE);
    }
    const target = await prisma.user.findUnique({
      where: { id: body.userId },
      select: { id: true },
    });
    if (target === null) {
      return sendError(reply, 404, 'NOT_FOUND', USER_NOT_FOUND_MESSAGE);
    }

    let created = true;
    try {
      await prisma.libraryAccess.create({
        data: { userId: target.id, libraryId: library.id, grantedById: request.user.id },
      });
    } catch (err) {
      // P2002 = unique(userId, libraryId) violation: the grant already exists
      // (or a concurrent request just created it) — idempotent no-op.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        created = false;
      } else {
        throw err;
      }
    }

    if (created) {
      await writeAuditLog(
        prisma,
        {
          action: 'access.granted',
          userId: request.user.id,
          targetType: 'user',
          targetId: target.id,
          ip: request.ip,
          details: { libraryId: library.id },
        },
        request.log,
      );
    }

    return reply.status(204).send();
  });

  // Revoke one user's access to one library. Idempotent: revoking a grant
  // that does not exist (unknown user, unknown library, or simply never
  // granted) is a 204 no-op without an audit row.
  app.delete('/libraries/:id/access/:userId', adminOnly, async (request, reply) => {
    const params = parseParams(revokeParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const { count } = await prisma.libraryAccess.deleteMany({
      where: { userId: params.userId, libraryId: params.id },
    });

    if (count > 0) {
      await writeAuditLog(
        prisma,
        {
          action: 'access.revoked',
          userId: request.user.id,
          targetType: 'user',
          targetId: params.userId,
          ip: request.ip,
          details: { libraryId: params.id },
        },
        request.log,
      );
    }

    return reply.status(204).send();
  });
};
