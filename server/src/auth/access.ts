import type { MediaItem } from '@prisma/client';

import { getPrisma } from '../db/client.js';
import { hasRating, isAllowed, type RatingFilter } from '../lib/content-rating.js';
import { forbiddenError, notFoundError } from '../lib/errors.js';
import { getSetting } from '../lib/settings.js';
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
//
// Parental controls (per-user content-rating cap) ride on the SAME seam:
// assertMediaItemAccess also throws the byte-identical NOT_FOUND when an item
// exceeds the user's `maxContentRating` cap, so a rating block is
// indistinguishable from a missing/ungranted item (no "this exists but is
// blocked" leak). Admins and users with no cap are exempt and pay ZERO extra
// queries — the default (unrestricted) path is unchanged. The ladder + rules
// live in lib/content-rating.ts; this module resolves an item's EFFECTIVE
// rating (a season/episode with no own rating inherits its show's, walking
// parentId) and applies isAllowed().

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
 * An item's EFFECTIVE content rating for parental-controls checks: its own
 * `contentRating` when set, otherwise the nearest ancestor's (episode -> season
 * -> show), walking `parentId`. A season/episode is rarely rated itself — the
 * certificate lives on the show — so the walk is what makes "cap a user at
 * PG-13" actually hide an R-rated show's episodes. Bounded (a media hierarchy
 * is at most show/season/episode deep) and only ever runs for a restricted,
 * non-admin user whose item has no own rating.
 */
async function effectiveContentRating(item: {
  contentRating: string | null;
  parentId: string | null;
}): Promise<string | null> {
  if (hasRating(item.contentRating)) return item.contentRating;
  let parentId = item.parentId;
  // Guard against a pathological cycle; a real hierarchy is <= 3 deep.
  for (let hop = 0; parentId !== null && hop < 6; hop += 1) {
    const parent = await getPrisma().mediaItem.findUnique({
      where: { id: parentId },
      select: { contentRating: true, parentId: true },
    });
    if (parent === null) return null;
    if (hasRating(parent.contentRating)) return parent.contentRating;
    parentId = parent.parentId;
  }
  return null;
}

/**
 * Whether `item` is viewable under the user's content-rating cap. Admins and
 * users with no cap short-circuit to true with no extra queries. A restricted
 * user's item is resolved to its effective rating and checked against isAllowed
 * with the server's blockUnrated policy.
 */
async function isMediaItemRatingAllowed(
  user: AuthUser,
  item: { contentRating: string | null; parentId: string | null },
): Promise<boolean> {
  if (isActiveAdmin(user)) return true;
  if (user.maxContentRating === null) return true;
  const blockUnrated = await getSetting('blockUnratedForRestrictedUsers');
  const rating = await effectiveContentRating(item);
  return isAllowed(rating, user.maxContentRating, blockUnrated);
}

/**
 * Loads a media item and enforces library access AND the per-user
 * content-rating cap in one step; returns the item so routes don't have to
 * fetch it again.
 *
 * Throws 404 NOT_FOUND when the item is missing — and, deliberately, the exact
 * same 404 when the item exists in a library the user has no grant for OR when
 * it exceeds the user's content-rating cap, so responses never reveal whether
 * an id exists or why it is inaccessible (no enumeration, no rating leak).
 */
export async function assertMediaItemAccess(
  user: AuthUser,
  mediaItemId: string,
): Promise<MediaItem> {
  const item = await getPrisma().mediaItem.findUnique({ where: { id: mediaItemId } });
  if (item === null || !(await canAccessLibrary(user, item.libraryId))) {
    throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
  }
  if (!(await isMediaItemRatingAllowed(user, item))) {
    throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
  }
  return item;
}

/**
 * The parental-controls filter to apply to a user's browse/search results, or
 * null when none applies (an admin or a user with no cap — both see everything,
 * and the query helpers add no rating predicate). Resolved once per request and
 * threaded into the media-query helpers (lib/media-query.ts) and the
 * continue-watching filter so listings, counts, feeds and search all agree with
 * the item-level enforcement above.
 */
export async function resolveRatingFilter(user: AuthUser): Promise<RatingFilter | null> {
  if (isActiveAdmin(user)) return null;
  if (user.maxContentRating === null) return null;
  const blockUnrated = await getSetting('blockUnratedForRestrictedUsers');
  return { maxContentRating: user.maxContentRating, blockUnrated };
}
