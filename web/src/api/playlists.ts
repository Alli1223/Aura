import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { apiRequest } from './client';
import type { MediaItem } from './media';

// Data layer for per-user playlists over the server's playlist routes
// (server routes/playlists.ts). Mirrors the server DTOs, owns the request
// builders + TanStack Query hooks, and reuses the shared MediaItem projection
// (== server SerializedItem) for playlist entries. Every mutation invalidates
// the playlist query root so the listing + any open detail reconcile.

// ---- DTOs (mirror server lib/playlists.ts) ----------------------------------

/** A playlist in the listing: identity, accessible item count and a poster. */
export interface PlaylistSummary {
  id: string;
  name: string;
  /** Items the caller can currently access (lost-access items excluded). */
  itemCount: number;
  /** The app's artwork route for the first accessible item with a poster, or null. */
  posterUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One ordered playlist entry, with the info a play button needs. */
export interface PlaylistItem extends MediaItem {
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
  createdAt: string;
  updatedAt: string;
  items: PlaylistItem[];
}

// ---- Requests ---------------------------------------------------------------

/** GET /api/playlists — the caller's playlists (most-recently-updated first). */
export async function getPlaylists(): Promise<PlaylistSummary[]> {
  const data = await apiRequest<{ playlists: PlaylistSummary[] }>('/playlists');
  return data.playlists;
}

/** GET /api/playlists/:id — a playlist + its accessible, ordered items. */
export async function getPlaylist(id: string): Promise<PlaylistDetail> {
  const data = await apiRequest<{ playlist: PlaylistDetail }>(
    `/playlists/${encodeURIComponent(id)}`,
  );
  return data.playlist;
}

/** POST /api/playlists — create an empty playlist. */
export async function createPlaylist(name: string): Promise<PlaylistDetail> {
  const data = await apiRequest<{ playlist: PlaylistDetail }>('/playlists', {
    method: 'POST',
    body: { name },
  });
  return data.playlist;
}

/** PATCH /api/playlists/:id — rename. */
export async function renamePlaylist(id: string, name: string): Promise<PlaylistDetail> {
  const data = await apiRequest<{ playlist: PlaylistDetail }>(
    `/playlists/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: { name } },
  );
  return data.playlist;
}

/** DELETE /api/playlists/:id — delete. */
export async function deletePlaylist(id: string): Promise<void> {
  await apiRequest<void>(`/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /api/playlists/:id/items — add a media item (access-checked server-side). */
export async function addPlaylistItem(id: string, mediaItemId: string): Promise<{ added: boolean }> {
  return apiRequest<{ added: boolean }>(`/playlists/${encodeURIComponent(id)}/items`, {
    method: 'POST',
    body: { mediaItemId },
  });
}

/** DELETE /api/playlists/:id/items/:mediaItemId — remove a media item. */
export async function removePlaylistItem(id: string, mediaItemId: string): Promise<void> {
  await apiRequest<void>(
    `/playlists/${encodeURIComponent(id)}/items/${encodeURIComponent(mediaItemId)}`,
    { method: 'DELETE' },
  );
}

/** PUT /api/playlists/:id/items — reorder to the given mediaItemId order. */
export async function reorderPlaylist(
  id: string,
  orderedItemIds: string[],
): Promise<PlaylistDetail> {
  const data = await apiRequest<{ playlist: PlaylistDetail }>(
    `/playlists/${encodeURIComponent(id)}/items`,
    { method: 'PUT', body: { orderedItemIds } },
  );
  return data.playlist;
}

// ---- Query keys -------------------------------------------------------------

export const playlistKeys = {
  all: ['playlists'] as const,
  list: ['playlists', 'list'] as const,
  detail: (id: string) => ['playlists', 'detail', id] as const,
};

// ---- Hooks ------------------------------------------------------------------

/** The caller's playlists (powers the Playlists page + the add-to-playlist menu). */
export function usePlaylists(options: { enabled?: boolean } = {}): UseQueryResult<PlaylistSummary[]> {
  return useQuery({
    queryKey: playlistKeys.list,
    queryFn: getPlaylists,
    enabled: options.enabled ?? true,
  });
}

/** Full detail for one playlist (the detail page + the player's queue context). */
export function usePlaylist(
  id: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<PlaylistDetail> {
  return useQuery({
    queryKey: playlistKeys.detail(id),
    queryFn: () => getPlaylist(id),
    enabled: (options.enabled ?? true) && id !== '',
  });
}

/** Create a playlist, then refresh the listing. */
export function useCreatePlaylist(): UseMutationResult<PlaylistDetail, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createPlaylist(name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
  });
}

/** Rename a playlist. */
export function useRenamePlaylist(
  id: string,
): UseMutationResult<PlaylistDetail, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => renamePlaylist(id, name),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
  });
}

/** Delete a playlist. */
export function useDeletePlaylist(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePlaylist(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
  });
}

/** Add an item to a playlist (used by the add-to-playlist menu). */
export function useAddPlaylistItem(): UseMutationResult<
  { added: boolean },
  Error,
  { playlistId: string; mediaItemId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ playlistId, mediaItemId }) => addPlaylistItem(playlistId, mediaItemId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
  });
}

/** Remove an item from a playlist. */
export function useRemovePlaylistItem(
  playlistId: string,
): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mediaItemId: string) => removePlaylistItem(playlistId, mediaItemId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
  });
}

/** Reorder a playlist to the given order. */
export function useReorderPlaylist(
  playlistId: string,
): UseMutationResult<PlaylistDetail, Error, string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderedItemIds: string[]) => reorderPlaylist(playlistId, orderedItemIds),
    onSuccess: (detail) => {
      queryClient.setQueryData(playlistKeys.detail(playlistId), detail);
      void queryClient.invalidateQueries({ queryKey: playlistKeys.all });
    },
  });
}
