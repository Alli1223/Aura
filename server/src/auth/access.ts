import type { MediaItem } from '@prisma/client';

import { getPrisma } from '../db/client.js';
import { forbiddenError, notFoundError } from '../lib/errors.js';
import type { AuthUser } from './types.js';

// Per-user library access enforcement — THE security seam for the product.
// Every media, image and stream route must gate through one of these helpers
// (or the guards built on them) so access control lives in exactly one place.
//
// Rules:
// - Admins can access every library.
// - Users can only access libraries with a LibraryAccess grant row.
// - Disabled users can access nothing. `authenticate` already rejects them,
//   but the helpers re-check as defence in depth (they may be called with a
//   user loaded outside the request lifecycle).
// - Grants are checked against the database on every call — never cached —
//   so a revocation takes effect immediately.
//
// Enumeration policy (deliberate): assertMediaItemAccess responds 404
// NOT_FOUND both when an item does not exist AND when it exists in a library
// the user has no grant for. A 403 there would confirm the item's existence
// and let an attacker enumerate ids in ungranted libraries. Library-level
// checks (canAccessLibrary/assertLibraryAccess) return a uniform 403 for
// every non-granted id — existing or not — which likewise leaks nothing.

const FORBIDDEN_LIBRARY_MESSAGE = 'You do not have access to this library';

/**
 * The one cloaking 404 message for media lookups. Exported so routes that
 * resolve an id themselves (e.g. a MediaFile id) before calling
 * assertMediaItemAccess can make their missing-id 404 byte-identical to the
 * access-denied 404 — any difference would leak which ids exist.
 */
export const ITEM_NOT_FOUND_MESSAGE = 'Media item not found';

function isActiveAdmin(user: AuthUser): boolean {
  return user.isEnabled && user.role === 'admin';
}

/**
 * Ids of every library the user may access. Admins: all libraries; users:
 * libraries with a LibraryAccess grant; disabled users: none.
 */
export async function getAccessibleLibraryIds(user: AuthUser): Promise<string[]> {
  if (!user.isEnabled) return [];
  const prisma = getPrisma();

  if (isActiveAdmin(user)) {
    const libraries = await prisma.library.findMany({ select: { id: true } });
    return libraries.map((library) => library.id);
  }

  const grants = await prisma.libraryAccess.findMany({
    where: { userId: user.id },
    select: { libraryId: true },
  });
  return grants.map((grant) => grant.libraryId);
}

/** Whether the user may access the given library. Never throws. */
export async function canAccessLibrary(user: AuthUser, libraryId: string): Promise<boolean> {
  if (!user.isEnabled) return false;
  if (isActiveAdmin(user)) return true;

  const grant = await getPrisma().libraryAccess.findUnique({
    where: { userId_libraryId: { userId: user.id, libraryId } },
    select: { id: true },
  });
  return grant !== null;
}

/**
 * Throws the standard 403 FORBIDDEN ApiError unless the user may access the
 * given library. The response is identical whether the library exists or
 * not, so it cannot be used to enumerate library ids.
 */
export async function assertLibraryAccess(user: AuthUser, libraryId: string): Promise<void> {
  if (!(await canAccessLibrary(user, libraryId))) {
    throw forbiddenError(FORBIDDEN_LIBRARY_MESSAGE);
  }
}

/**
 * Loads a media item and enforces library access in one step; returns the
 * item so routes don't have to fetch it again.
 *
 * Throws 404 NOT_FOUND when the item is missing — and, deliberately, the
 * exact same 404 when the item exists in a library the user has no grant
 * for, so responses never reveal whether an id exists (no enumeration).
 */
export async function assertMediaItemAccess(
  user: AuthUser,
  mediaItemId: string,
): Promise<MediaItem> {
  const item = await getPrisma().mediaItem.findUnique({ where: { id: mediaItemId } });
  if (item === null || !(await canAccessLibrary(user, item.libraryId))) {
    throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
  }
  return item;
}
