import type { Playlist } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { assertMediaItemAccess } from '../auth/access.js';
import type { AuthUser } from '../auth/types.js';
import { getPrisma } from '../db/client.js';
import { notFoundError } from '../lib/errors.js';
import {
  getPlaylistDetail,
  listPlaylists,
  nextPlaylistOrder,
  type PlaylistDetail,
} from '../lib/playlists.js';
import { parseBody, parseParams } from '../lib/validation.js';

// Per-user playlists of arbitrary videos with ordering + continuous playback.
//
// Every route authenticates and is scoped to the caller's OWN playlists: a
// playlist id owned by another user (or a non-existent id) is cloaked as the
// byte-identical 404 NOT_FOUND, so playlist ids can never be enumerated across
// users. Adding an item is gated by assertMediaItemAccess, so a user can only
// ever add a media item they can already see (and an inaccessible/nonexistent
// media id 404-cloaks). Reading a playlist filters its items to those the caller
// can currently access (see lib/playlists.ts), so a later-revoked grant or a
// tightened parental cap silently drops the affected items.
//
// Registered on the /api/playlists prefix.

const PLAYLIST_NOT_FOUND_MESSAGE = 'Playlist not found';
/** Upper bound on ids accepted by a reorder request (abuse guard). */
const MAX_REORDER_IDS = 1000;

const playlistIdParamsSchema = z.object({ id: z.string().min(1, 'Playlist id is required') });
const playlistItemParamsSchema = z.object({
  id: z.string().min(1, 'Playlist id is required'),
  mediaItemId: z.string().min(1, 'Media item id is required'),
});

const nameSchema = z
  .string('Name is required')
  .trim()
  .min(1, 'Name is required')
  .max(100, 'Name is too long');

const createPlaylistSchema = z.object({ name: nameSchema });
const renamePlaylistSchema = z.object({ name: nameSchema });
const addItemSchema = z.object({
  mediaItemId: z.string('mediaItemId is required').min(1, 'mediaItemId is required'),
});
const reorderSchema = z.object({
  orderedItemIds: z
    .array(z.string().min(1, 'Each id must be a non-empty string'), {
      error: 'orderedItemIds must be an array of media item ids',
    })
    .max(MAX_REORDER_IDS, `A reorder may list at most ${MAX_REORDER_IDS} ids`),
});

/**
 * Loads a playlist and enforces the owner-only 404 cloak: a playlist that does
 * not exist AND one owned by another user both throw the byte-identical
 * NOT_FOUND, so a caller can never tell whether a playlist id exists.
 */
async function loadOwnedPlaylist(user: AuthUser, playlistId: string): Promise<Playlist> {
  const playlist = await getPrisma().playlist.findUnique({ where: { id: playlistId } });
  if (playlist === null || playlist.userId !== user.id) {
    throw notFoundError(PLAYLIST_NOT_FOUND_MESSAGE);
  }
  return playlist;
}

export const playlistRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const authedOnly = { preHandler: [app.authenticate] };

  // The caller's playlists (most-recently-updated first) with accessible item
  // counts + a poster from the first accessible item.
  app.get('/', authedOnly, async (request) => {
    return { playlists: await listPlaylists(request.user) };
  });

  // Create an empty playlist owned by the caller.
  app.post('/', authedOnly, async (request, reply) => {
    const body = parseBody(createPlaylistSchema, request.body, reply);
    if (body === undefined) return reply;

    const playlist = await prisma.playlist.create({
      data: { userId: request.user.id, name: body.name },
    });
    const detail = await getPlaylistDetail(request.user, playlist);
    return reply.status(201).send({ playlist: detail });
  });

  // Full detail: the playlist + its items, filtered to what the caller can see.
  app.get('/:id', authedOnly, async (request, reply) => {
    const params = parseParams(playlistIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const playlist = await loadOwnedPlaylist(request.user, params.id);
    return { playlist: await getPlaylistDetail(request.user, playlist) };
  });

  // Rename (owner-only; 404 cloak for another user's / a missing id).
  app.patch('/:id', authedOnly, async (request, reply) => {
    const params = parseParams(playlistIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(renamePlaylistSchema, request.body, reply);
    if (body === undefined) return reply;

    await loadOwnedPlaylist(request.user, params.id);
    const playlist = await prisma.playlist.update({
      where: { id: params.id },
      data: { name: body.name },
    });
    return { playlist: await getPlaylistDetail(request.user, playlist) };
  });

  // Delete (owner-only). Cascades away the playlist's items. Idempotent-ish: a
  // missing/other-user id 404-cloaks like every other playlist route.
  app.delete('/:id', authedOnly, async (request, reply) => {
    const params = parseParams(playlistIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    await loadOwnedPlaylist(request.user, params.id);
    await prisma.playlist.delete({ where: { id: params.id } });
    return reply.status(204).send();
  });

  // Add a media item. The item is access-checked FIRST (assertMediaItemAccess),
  // so an inaccessible/nonexistent media id 404-cloaks and never reveals the
  // playlist accepted it. Idempotent: re-adding an item is a no-op (200).
  app.post('/:id/items', authedOnly, async (request, reply) => {
    const params = parseParams(playlistIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(addItemSchema, request.body, reply);
    if (body === undefined) return reply;

    const playlist = await loadOwnedPlaylist(request.user, params.id);
    const item = await assertMediaItemAccess(request.user, body.mediaItemId);

    const existing = await prisma.playlistItem.findUnique({
      where: { playlistId_mediaItemId: { playlistId: playlist.id, mediaItemId: item.id } },
      select: { id: true },
    });
    if (existing !== null) {
      return reply.status(200).send({ added: false });
    }

    const order = await nextPlaylistOrder(playlist.id);
    await prisma.playlistItem.create({
      data: { playlistId: playlist.id, mediaItemId: item.id, order },
    });
    // Bump the playlist's updatedAt so a just-modified playlist floats to the
    // top of the listing.
    await prisma.playlist.update({ where: { id: playlist.id }, data: {} });
    return reply.status(201).send({ added: true });
  });

  // Remove a media item. Idempotent: removing an absent item still 204s. The
  // media id is NOT access-checked (a caller may remove an item they have since
  // lost access to — it's their own playlist), only the playlist ownership is.
  app.delete('/:id/items/:mediaItemId', authedOnly, async (request, reply) => {
    const params = parseParams(playlistItemParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const playlist = await loadOwnedPlaylist(request.user, params.id);
    await prisma.playlistItem.deleteMany({
      where: { playlistId: playlist.id, mediaItemId: params.mediaItemId },
    });
    await prisma.playlist.update({ where: { id: playlist.id }, data: {} });
    return reply.status(204).send();
  });

  // Reorder. `orderedItemIds` lists mediaItemIds in the desired order. Ids not in
  // the playlist are ignored; any current items the request omits keep their
  // relative order and sink to the end — so a caller that only sees (and thus can
  // only reorder) a subset never accidentally drops the hidden ones.
  app.put('/:id/items', authedOnly, async (request, reply) => {
    const params = parseParams(playlistIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(reorderSchema, request.body, reply);
    if (body === undefined) return reply;

    const playlist = await loadOwnedPlaylist(request.user, params.id);
    const current = await prisma.playlistItem.findMany({
      where: { playlistId: playlist.id },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
      select: { id: true, mediaItemId: true },
    });
    const idToRow = new Map(current.map((row) => [row.mediaItemId, row]));

    // Provided ids that actually belong to the playlist, deduped, in order.
    const seen = new Set<string>();
    const orderedRows: { id: string }[] = [];
    for (const mediaItemId of body.orderedItemIds) {
      if (seen.has(mediaItemId)) continue;
      const row = idToRow.get(mediaItemId);
      if (row === undefined) continue;
      seen.add(mediaItemId);
      orderedRows.push(row);
    }
    // Any current items the request omitted, in their existing order, appended.
    for (const row of current) {
      if (!seen.has(row.mediaItemId)) orderedRows.push(row);
    }

    await prisma.$transaction([
      ...orderedRows.map((row, index) =>
        prisma.playlistItem.update({ where: { id: row.id }, data: { order: index } }),
      ),
      prisma.playlist.update({ where: { id: playlist.id }, data: {} }),
    ]);

    const detail: PlaylistDetail = await getPlaylistDetail(request.user, playlist);
    return { playlist: detail };
  });
};
