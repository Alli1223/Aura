import { Prisma, type Playlist } from '@prisma/client';

import { getAccessibleLibraryIds, resolveRatingFilter } from '../auth/access.js';
import type { AuthUser } from '../auth/types.js';
import { getPrisma } from '../db/client.js';
import {
  filterItemIdsByRating,
  resolveItemStates,
  serializeItem,
  type SerializedItem,
} from './media-query.js';

// Read-model / service backing the playlists API (routes/playlists.ts). It owns
// the access-filtered serialization of a user's playlists and their items.
//
// Access contract (mirrors the browse API): a playlist row is loaded and
// ownership-checked by the route (the 404 cloak), but a playlist may reference
// media items the caller has since lost access to (a revoked library grant or a
// tightened parental-controls cap). Those items are OMITTED from every playlist
// surface here — the same library-grant ∩ content-rating filter the browse feeds
// apply — so a playlist can never resurface an item its owner may no longer see.
// The playlist itself stays intact in the DB; only its visible projection shrinks.

/** Include that pulls a media item's genre names in a stable order (serializer input). */
const GENRES_INCLUDE = {
  genres: { select: { name: true }, orderBy: { name: 'asc' } },
} as const satisfies Prisma.MediaItemInclude;

/** A playlist in the listing: identity, its accessible item count and a poster. */
export interface PlaylistSummary {
  id: string;
  name: string;
  /** Items the caller can currently access (lost-access items are excluded). */
  itemCount: number;
  /** The app's artwork route for the first accessible item with a poster, or null. */
  posterUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One serialized, ordered playlist entry with the info a play button needs. */
export interface SerializedPlaylistItem extends SerializedItem {
  /** 0-based position within the playlist (contiguous, ascending). */
  order: number;
  /** Whether the item has at least one available (playable) file. */
  hasFile: boolean;
  /** The file the play button should stream, or null when none is available. */
  primaryMediaFileId: string | null;
}

/** Full playlist detail: identity plus its access-filtered, ordered items. */
export interface PlaylistDetail {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  items: SerializedPlaylistItem[];
}

/** Minimal media-item shape the access filter needs. */
interface AccessCandidate {
  id: string;
  libraryId: string;
  contentRating: string | null;
  parentId: string | null;
}

/**
 * The subset of `items` the user may currently access, as a Set of ids: gated by
 * both a library grant AND the per-user content-rating cap, exactly like the
 * browse feeds. Admins / unrestricted users keep every id in an accessible
 * library. Resolved in a bounded number of queries (no per-item walk).
 */
async function accessibleItemIds(
  user: AuthUser,
  items: readonly AccessCandidate[],
): Promise<Set<string>> {
  if (items.length === 0) return new Set();
  const accessibleLibraryIds = new Set(await getAccessibleLibraryIds(user));
  const inLibrary = items.filter((item) => accessibleLibraryIds.has(item.libraryId));
  const ratingFilter = await resolveRatingFilter(user);
  const allowed = await filterItemIdsByRating(inLibrary, ratingFilter);
  return new Set(inLibrary.filter((item) => allowed.has(item.id)).map((item) => item.id));
}

/**
 * The caller's playlists (most-recently-updated first), each with its accessible
 * item count and a poster taken from the first accessible item that has one.
 * Access is resolved once across every playlist's items, so the whole listing
 * costs a bounded number of queries regardless of playlist/item counts.
 */
export async function listPlaylists(user: AuthUser): Promise<PlaylistSummary[]> {
  const playlists = await getPrisma().playlist.findMany({
    where: { userId: user.id },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    include: {
      items: {
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
        include: {
          mediaItem: {
            select: {
              id: true,
              libraryId: true,
              contentRating: true,
              parentId: true,
              posterPath: true,
            },
          },
        },
      },
    },
  });

  const allItems = playlists.flatMap((playlist) => playlist.items.map((item) => item.mediaItem));
  const accessible = await accessibleItemIds(user, allItems);

  return playlists.map((playlist) => {
    const visible = playlist.items.filter((item) => accessible.has(item.mediaItemId));
    const posterItem = visible.find(
      (item) => item.mediaItem.posterPath !== null && item.mediaItem.posterPath !== '',
    );
    return {
      id: playlist.id,
      name: playlist.name,
      itemCount: visible.length,
      posterUrl:
        posterItem === undefined ? null : `/api/items/${posterItem.mediaItemId}/artwork/poster`,
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
    };
  });
}

/**
 * Full detail for one (already ownership-checked) playlist: its ordered items,
 * filtered to those the caller can currently access, each serialized with its
 * watch-state overlay and the primary playable file id. Items the caller has
 * lost access to are silently dropped (never surfaced), matching item-level
 * enforcement.
 */
export async function getPlaylistDetail(
  user: AuthUser,
  playlist: Playlist,
): Promise<PlaylistDetail> {
  const prisma = getPrisma();
  const rows = await prisma.playlistItem.findMany({
    where: { playlistId: playlist.id },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    include: { mediaItem: { include: GENRES_INCLUDE } },
  });

  const accessible = await accessibleItemIds(user, rows.map((row) => row.mediaItem));
  const visible = rows.filter((row) => accessible.has(row.mediaItemId));

  const mediaItems = visible.map((row) => row.mediaItem);
  const states = await resolveItemStates(user.id, mediaItems);

  // The primary (oldest available) file per accessible item, for the play button.
  const files =
    mediaItems.length === 0
      ? []
      : await prisma.mediaFile.findMany({
          where: { mediaItemId: { in: mediaItems.map((item) => item.id) }, status: 'available' },
          select: { id: true, mediaItemId: true },
          orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
        });
  const primaryByItem = new Map<string, string>();
  for (const file of files) {
    if (!primaryByItem.has(file.mediaItemId)) primaryByItem.set(file.mediaItemId, file.id);
  }

  return {
    id: playlist.id,
    name: playlist.name,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
    // Re-index visible items to a contiguous 0-based order so the client's
    // playlist index (used for the player queue) matches array position even
    // when a hidden item sits between two visible ones.
    items: visible.map((row, index) => ({
      ...serializeItem(row.mediaItem, states.get(row.mediaItemId)),
      order: index,
      hasFile: primaryByItem.has(row.mediaItemId),
      primaryMediaFileId: primaryByItem.get(row.mediaItemId) ?? null,
    })),
  };
}

/** The next `order` value for a playlist (max existing + 1, or 0 when empty). */
export async function nextPlaylistOrder(playlistId: string): Promise<number> {
  const last = await getPrisma().playlistItem.findFirst({
    where: { playlistId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  return last === null ? 0 : last.order + 1;
}
