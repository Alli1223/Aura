import { Prisma, type Library, type LibraryPath } from '@prisma/client';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { canAccessLibrary, getAccessibleLibraryIds } from '../auth/access.js';
import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { libraryTypeSchema } from '../db/constants.js';
import { writeAuditLog } from '../lib/audit.js';
import { ApiError, sendError } from '../lib/errors.js';
import { validateLibraryPath } from '../lib/media-roots.js';
import { parseBody, parseParams } from '../lib/validation.js';
import { refreshLibraryWatcher } from '../scanner/library-watcher.js';

// Library management. Reads are available to every authenticated user but
// scoped to the libraries they can access (admins see all); writes are
// admin only.
//
// Enumeration policy: GET /:id answers with a byte-identical 404 NOT_FOUND
// whether the id does not exist or exists in a library the caller has no
// grant for (same stance as assertMediaItemAccess).
//
// Path rules: every path must validate through validateLibraryPath (absolute,
// existing directory inside MEDIA_ROOTS) and is stored in canonical realpath
// form. A path may belong to exactly one library — duplicates within a
// request or against another library's paths are 409 PATH_IN_USE.
//
// Conflict codes: NAME_TAKEN (409), PATH_IN_USE (409), TYPE_IMMUTABLE (400 —
// metadata semantics differ per type, so a library's type is fixed at
// creation).

export interface LibraryRoutesOptions {
  config: Config;
}

const LIBRARY_NOT_FOUND_MESSAGE = 'Library not found';
const NAME_TAKEN_MESSAGE = 'A library with this name already exists';

const libraryIdParamsSchema = z.object({ id: z.string().min(1, 'Library id is required') });

const nameSchema = z
  .string('Library name is required')
  .trim()
  .min(1, 'Library name is required')
  .max(100, 'Library name must be 100 characters or fewer');

const pathsSchema = z
  .array(z.string('Each path must be a string').min(1, 'Paths must not be empty'), {
    error: 'paths must be an array of directory paths',
  })
  .min(1, 'At least one path is required');

const createLibrarySchema = z.object({
  name: nameSchema,
  type: libraryTypeSchema,
  paths: pathsSchema,
});

const updateLibrarySchema = z
  .object({
    name: nameSchema.optional(),
    type: libraryTypeSchema.optional(),
    paths: pathsSchema.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.type !== undefined || body.paths !== undefined,
    { message: 'At least one of name, type or paths must be provided' },
  );

/** Public shape of a library; paths flattened to their canonical strings. */
function toLibraryResponse(library: Library & { paths: LibraryPath[] }) {
  return {
    id: library.id,
    name: library.name,
    type: library.type,
    paths: library.paths.map((entry) => entry.path),
    createdAt: library.createdAt,
    updatedAt: library.updatedAt,
  };
}

function isNameUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    JSON.stringify(err.meta?.target ?? '').includes('name')
  );
}

/**
 * Validates and canonicalises every requested path, rejecting duplicates
 * within the request itself (two inputs may canonicalise to the same
 * directory, e.g. a symlink and its target). Order is preserved.
 */
async function canonicalisePaths(
  paths: readonly string[],
  mediaRoots: readonly string[],
): Promise<string[]> {
  const canonical: string[] = [];
  for (const candidate of paths) {
    const resolved = await validateLibraryPath(candidate, mediaRoots);
    if (canonical.includes(resolved)) {
      throw new ApiError(409, 'PATH_IN_USE', `Path "${resolved}" is listed more than once`);
    }
    canonical.push(resolved);
  }
  return canonical;
}

/**
 * Throws 409 PATH_IN_USE if any of the canonical paths already belongs to a
 * library other than `excludeLibraryId`. Runs inside the mutating transaction
 * so concurrent writes cannot race past the check (LibraryPath.path is only
 * unique per library at the schema level; global one-library-per-path is an
 * application rule enforced here).
 */
async function assertPathsAvailable(
  tx: Prisma.TransactionClient,
  paths: readonly string[],
  excludeLibraryId?: string,
): Promise<void> {
  const clash = await tx.libraryPath.findFirst({
    where: {
      path: { in: [...paths] },
      ...(excludeLibraryId === undefined ? {} : { libraryId: { not: excludeLibraryId } }),
    },
  });
  if (clash !== null) {
    throw new ApiError(
      409,
      'PATH_IN_USE',
      `Path "${clash.path}" already belongs to another library`,
    );
  }
}

/**
 * Fire-and-forget refresh of the process-wide filesystem watcher after a
 * library mutation, so it starts/stops tracking new/removed paths immediately
 * instead of waiting for the next periodic rescan. Never blocks or fails the
 * HTTP response: the (possibly slow) re-sync is detached and any error is
 * logged, never thrown. A safe no-op when no watcher is running (NODE_ENV=test,
 * WATCH_ENABLED=false, or before startup wiring sets one).
 */
function scheduleWatcherRefresh(log: FastifyBaseLogger): void {
  void refreshLibraryWatcher().catch((err: unknown) => {
    log.error({ err }, 'library-watcher: refresh after library mutation failed');
  });
}

export const libraryRoutes: FastifyPluginAsync<LibraryRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();
  const mediaRoots = opts.config.MEDIA_ROOTS;
  const authedOnly = { preHandler: [app.authenticate] };
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // Libraries the caller can access, with paths — powers the sidebar.
  app.get('/', authedOnly, async (request) => {
    const accessibleIds = await getAccessibleLibraryIds(request.user);
    const libraries = await prisma.library.findMany({
      where: { id: { in: accessibleIds } },
      include: { paths: { orderBy: { path: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    return { libraries: libraries.map(toLibraryResponse) };
  });

  app.get('/:id', authedOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const library = await prisma.library.findUnique({
      where: { id: params.id },
      include: { paths: { orderBy: { path: 'asc' } } },
    });
    // Deliberately identical 404s for "does not exist" and "no grant": the
    // response must never reveal whether a library id exists.
    if (library === null || !(await canAccessLibrary(request.user, library.id))) {
      return sendError(reply, 404, 'NOT_FOUND', LIBRARY_NOT_FOUND_MESSAGE);
    }
    return { library: toLibraryResponse(library) };
  });

  app.post('/', adminOnly, async (request, reply) => {
    const body = parseBody(createLibrarySchema, request.body, reply);
    if (body === undefined) return reply;

    const paths = await canonicalisePaths(body.paths, mediaRoots);

    let created: Library & { paths: LibraryPath[] };
    try {
      created = await prisma.$transaction(async (tx) => {
        await assertPathsAvailable(tx, paths);
        return tx.library.create({
          data: {
            name: body.name,
            type: body.type,
            paths: { create: paths.map((path) => ({ path })) },
          },
          include: { paths: { orderBy: { path: 'asc' } } },
        });
      });
    } catch (err) {
      if (isNameUniqueViolation(err)) {
        return sendError(reply, 409, 'NAME_TAKEN', NAME_TAKEN_MESSAGE);
      }
      throw err;
    }

    await writeAuditLog(
      prisma,
      {
        action: 'library.created',
        userId: request.user.id,
        targetType: 'library',
        targetId: created.id,
        ip: request.ip,
        details: { name: created.name, type: created.type, paths },
      },
      request.log,
    );

    // Watch the new library's paths now, not at the next periodic rescan.
    scheduleWatcherRefresh(request.log);

    return reply.status(201).send({ library: toLibraryResponse(created) });
  });

  app.patch('/:id', adminOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(updateLibrarySchema, request.body, reply);
    if (body === undefined) return reply;

    const existing = await prisma.library.findUnique({
      where: { id: params.id },
      include: { paths: { orderBy: { path: 'asc' } } },
    });
    if (existing === null) {
      return sendError(reply, 404, 'NOT_FOUND', LIBRARY_NOT_FOUND_MESSAGE);
    }
    if (body.type !== undefined && body.type !== existing.type) {
      return sendError(
        reply,
        400,
        'TYPE_IMMUTABLE',
        'A library type cannot be changed after creation',
      );
    }

    const paths =
      body.paths === undefined ? undefined : await canonicalisePaths(body.paths, mediaRoots);

    let updated: Library & { paths: LibraryPath[] };
    try {
      updated = await prisma.$transaction(async (tx) => {
        if (paths !== undefined) {
          await assertPathsAvailable(tx, paths, existing.id);
          // Replace the whole set: the request body is the desired state.
          await tx.libraryPath.deleteMany({ where: { libraryId: existing.id } });
          await tx.libraryPath.createMany({
            data: paths.map((path) => ({ libraryId: existing.id, path })),
          });
        }
        return tx.library.update({
          where: { id: existing.id },
          data: body.name === undefined ? {} : { name: body.name },
          include: { paths: { orderBy: { path: 'asc' } } },
        });
      });
    } catch (err) {
      if (isNameUniqueViolation(err)) {
        return sendError(reply, 409, 'NAME_TAKEN', NAME_TAKEN_MESSAGE);
      }
      throw err;
    }

    await writeAuditLog(
      prisma,
      {
        action: 'library.updated',
        userId: request.user.id,
        targetType: 'library',
        targetId: updated.id,
        ip: request.ip,
        details: {
          ...(body.name === undefined || body.name === existing.name
            ? {}
            : { name: { from: existing.name, to: updated.name } }),
          ...(paths === undefined
            ? {}
            : { paths: { from: existing.paths.map((entry) => entry.path), to: paths } }),
        },
      },
      request.log,
    );

    // Only a path change alters what the watcher tracks; a rename does not.
    if (paths !== undefined) scheduleWatcherRefresh(request.log);

    return reply.send({ library: toLibraryResponse(updated) });
  });

  app.delete('/:id', adminOnly, async (request, reply) => {
    const params = parseParams(libraryIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const existing = await prisma.library.findUnique({
      where: { id: params.id },
      include: { paths: true },
    });
    if (existing === null) {
      return sendError(reply, 404, 'NOT_FOUND', LIBRARY_NOT_FOUND_MESSAGE);
    }

    // Cascades remove paths, media items (and their files/streams/watch
    // states) and access grants via the schema's onDelete rules.
    await prisma.library.delete({ where: { id: existing.id } });

    await writeAuditLog(
      prisma,
      {
        action: 'library.deleted',
        userId: request.user.id,
        targetType: 'library',
        targetId: existing.id,
        ip: request.ip,
        details: {
          name: existing.name,
          type: existing.type,
          paths: existing.paths.map((entry) => entry.path),
        },
      },
      request.log,
    );

    // Stop watching the removed library's paths immediately.
    scheduleWatcherRefresh(request.log);

    return reply.status(204).send();
  });
};
