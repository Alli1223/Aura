import { Prisma, type Collection } from '@prisma/client';

import { getAccessibleLibraryIds, resolveRatingFilter } from '../auth/access.js';
import type { AuthUser } from '../auth/types.js';
import { getPrisma } from '../db/client.js';
import { notFoundError } from './errors.js';
import { buildRatingWhere, resolveItemStates, serializeItem, type SerializedItem } from './media-query.js';

// Read-model / query service for collections (routes/collections.ts). Owns the
// serialization of a Collection into the safe browse shapes the web app
// consumes and the VISIBILITY rule that keeps a caller from ever seeing a
// collection whose members they cannot access.
//
// Visibility rule (the security seam for this feature): a collection is visible
// to a caller iff it has at least one member MediaItem that the caller may
// access — i.e. the member is in a granted library AND passes the caller's
// parental (content-rating) filter. Both constraints reuse the exact same
// primitives as the browse API (getAccessibleLibraryIds + buildRatingWhere), so
// collection visibility can never widen past library grants or rating caps.
// Every listed item and every counted item is filtered by that same predicate,
// so counts, posters and detail listings all agree.
//
// Collections group top-level items (movies), which carry their OWN
// contentRating, so the DB-level rating predicate is both correct and complete
// here (no ancestor walk, as with the library listing).

/** The one cloaking 404 for collection lookups (unknown OR invisible id). */
export const COLLECTION_NOT_FOUND_MESSAGE = 'Collection not found';

/** Safe projection of a collection for the browse grid (no fs paths leaked). */
export interface SerializedCollection {
  id: string;
  name: string;
  sortName: string;
  overview: string | null;
  /** One of COLLECTION_SOURCES: "manual" | "tmdb". */
  source: string;
  tmdbCollectionId: number | null;
  /** How many members the caller can actually access. */
  itemCount: number;
  /**
   * The app's artwork route for the collection's poster, or null when it has
   * none. Points at the collection's own poster when set, else the first
   * accessible member's poster (via the item artwork route).
   */
  posterUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A collection plus its members serialized in curated order. */
export interface CollectionDetail {
  collection: SerializedCollection;
  items: SerializedItem[];
}

/** Pulls a member item's genre names in a stable order (serializer input). */
const GENRES_INCLUDE = {
  genres: { select: { name: true }, orderBy: { name: 'asc' } },
} as const satisfies Prisma.MediaItemInclude;

/** A member row carrying only what a poster/count needs. */
interface PosterItemRow {
  mediaItem: { id: string; posterPath: string | null };
}

/**
 * The MediaItem predicate isolating exactly the collection members a caller may
 * see: in a granted library AND passing the parental filter. Resolved once per
 * request from the same helpers the browse API uses.
 */
async function viewerItemWhere(user: AuthUser): Promise<Prisma.MediaItemWhereInput> {
  const libraryIds = await getAccessibleLibraryIds(user);
  const ratingFilter = await resolveRatingFilter(user);
  return { libraryId: { in: libraryIds }, ...buildRatingWhere(ratingFilter) };
}

/** Whether a member's poster path is a usable artwork source. */
function hasPoster(posterPath: string | null): boolean {
  return posterPath !== null && posterPath !== '';
}

/** The collection's poster route, its own art first then the first member's. */
function collectionPosterUrl(
  collection: { id: string; posterPath: string | null },
  firstMemberPosterId: string | null,
): string | null {
  if (hasPoster(collection.posterPath)) return `/api/collections/${collection.id}/poster`;
  if (firstMemberPosterId !== null) return `/api/items/${firstMemberPosterId}/artwork/poster`;
  return null;
}

/** Builds the safe summary from a collection and its accessible member rows. */
function buildSummary(collection: Collection, accessibleItems: PosterItemRow[]): SerializedCollection {
  const firstWithPoster = accessibleItems.find((item) => hasPoster(item.mediaItem.posterPath));
  return {
    id: collection.id,
    name: collection.name,
    sortName: collection.sortName,
    overview: collection.overview,
    source: collection.source,
    tmdbCollectionId: collection.tmdbCollectionId,
    itemCount: accessibleItems.length,
    posterUrl: collectionPosterUrl(collection, firstWithPoster?.mediaItem.id ?? null),
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

/**
 * Every collection VISIBLE to the caller (has ≥1 accessible member), sorted by
 * name, each with a computed poster and the caller's accessible member count.
 * Admins (all libraries, no rating cap) see every non-empty collection.
 */
export async function listVisibleCollections(user: AuthUser): Promise<SerializedCollection[]> {
  const prisma = getPrisma();
  const itemWhere = await viewerItemWhere(user);
  const collections = await prisma.collection.findMany({
    where: { items: { some: { mediaItem: itemWhere } } },
    include: {
      items: {
        where: { mediaItem: itemWhere },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        include: { mediaItem: { select: { id: true, posterPath: true } } },
      },
    },
    orderBy: [{ sortName: 'asc' }, { id: 'asc' }],
  });
  return collections.map((collection) => buildSummary(collection, collection.items));
}

/**
 * The caller's view of one collection: its summary plus its members serialized
 * (media-query shape, with watch-state overlays) in curated order, FILTERED to
 * the members the caller can access.
 *
 * Throws the cloaking 404 when the id is unknown OR the caller can access none
 * of its members, so an invisible collection is indistinguishable from a
 * missing one (no enumeration).
 */
export async function getCollectionDetail(user: AuthUser, id: string): Promise<CollectionDetail> {
  const prisma = getPrisma();
  const itemWhere = await viewerItemWhere(user);
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      items: {
        where: { mediaItem: itemWhere },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        include: { mediaItem: { include: GENRES_INCLUDE } },
      },
    },
  });
  if (collection === null || collection.items.length === 0) {
    throw notFoundError(COLLECTION_NOT_FOUND_MESSAGE);
  }

  const rows = collection.items.map((entry) => entry.mediaItem);
  const states = await resolveItemStates(user.id, rows);
  const items = rows.map((row) => serializeItem(row, states.get(row.id)));
  return { collection: buildSummary(collection, collection.items), items };
}

/**
 * The caller's summary of one collection (no member serialization), or null
 * when the id is unknown. Note this returns a summary even for a collection the
 * caller cannot see any member of (itemCount 0) — the admin routes call it after
 * a mutation to echo the current state, and those routes are admin-only.
 */
export async function getCollectionSummary(
  user: AuthUser,
  id: string,
): Promise<SerializedCollection | null> {
  const prisma = getPrisma();
  const itemWhere = await viewerItemWhere(user);
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      items: {
        where: { mediaItem: itemWhere },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        include: { mediaItem: { select: { id: true, posterPath: true } } },
      },
    },
  });
  if (collection === null) return null;
  return buildSummary(collection, collection.items);
}

/**
 * The artwork source URI for a collection's poster, or null when the caller
 * cannot see the collection (unknown/invisible) or it has no resolvable poster.
 * The route maps null to the same cloaking 404 as the rest of the surface.
 * Prefers the collection's own poster, falling back to the first accessible
 * member's — so the route is robust even if hit directly.
 */
export async function resolveCollectionPosterSource(
  user: AuthUser,
  id: string,
): Promise<string | null> {
  const prisma = getPrisma();
  const itemWhere = await viewerItemWhere(user);
  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      items: {
        where: { mediaItem: itemWhere },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        include: { mediaItem: { select: { posterPath: true } } },
      },
    },
  });
  if (collection === null || collection.items.length === 0) return null;
  if (hasPoster(collection.posterPath)) return collection.posterPath;
  const firstWithPoster = collection.items.find((entry) => hasPoster(entry.mediaItem.posterPath));
  return firstWithPoster?.mediaItem.posterPath ?? null;
}
