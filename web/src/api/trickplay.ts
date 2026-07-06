import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { API_BASE, ApiError, apiRequest } from './client';

// Client data layer for the trickplay (BIF-style scrub-preview) endpoints
// (server routes/trickplay.ts). A media file has a JSON manifest describing a
// set of JPEG sprite SHEETS — a grid of evenly-spaced thumbnails, one frame
// every `intervalSec` seconds — and the math to map a scrub time to the sheet +
// tile a client should draw. The player renders that tile as a hover preview.
//
// Both endpoints are authenticated by the short-lived `?token=` streaming token
// minted by /decide (the same token the HLS/subtitle routes use), so they carry
// the token in the URL query and skip the JWT silent-refresh dance. A missing
// preview (trickplay disabled, or ffmpeg cannot produce sprites for the file)
// answers 404 — the feature is best-effort and simply absent in that case.

// ---- DTOs (mirror server media/trickplay.ts TrickplayManifest) --------------

/**
 * The tile map for one media file's trickplay sprites. Map a scrub time to a
 * thumbnail with `index = clamp(floor(time / intervalSec), 0, thumbnailCount-1)`,
 * then `sheet = floor(index / tilesPerSheet)`, `withinSheet = index %
 * tilesPerSheet`, `col = withinSheet % columns`, `row = floor(withinSheet /
 * columns)`, and draw `sheets[sheet]` at pixel offset `(col*thumbWidth,
 * row*thumbHeight)` sized `thumbWidth x thumbHeight`. See locateThumbnail.
 */
export interface TrickplayManifest {
  version: number;
  mediaFileId: string;
  sourceSize: number;
  sourceMtimeMs: number;
  /** Seconds between consecutive thumbnails. */
  intervalSec: number;
  /** Pixel width of one thumbnail tile. */
  thumbWidth: number;
  /** Pixel height of one thumbnail tile. */
  thumbHeight: number;
  /** Columns of tiles per sheet. */
  columns: number;
  /** Rows of tiles per sheet. */
  rows: number;
  /** Tiles per full sheet (columns * rows). */
  tilesPerSheet: number;
  /** Total real thumbnails across all sheets (last sheet may be padded). */
  thumbnailCount: number;
  /** Sprite sheet filenames in order (index 0 = earliest thumbnails). */
  sheets: string[];
}

/** Where one thumbnail sits: which sheet and the pixel rectangle within it. */
export interface ThumbnailLocation {
  /** Thumbnail index (0-based). */
  index: number;
  /** Sprite sheet filename to draw. */
  sheet: string;
  /** Pixel offset of the tile within the sheet. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---- Tile math (ported from server media/trickplay.ts locateThumbnail) ------

/**
 * Resolves a scrub time (seconds) to the thumbnail a client should draw. A
 * faithful port of the server's locateThumbnail so both share one source of
 * truth: `index = clamp(floor(t/intervalSec), 0, thumbnailCount-1)`, then the
 * sheet + within-sheet column/row and the tile's pixel offset.
 */
export function locateThumbnail(manifest: TrickplayManifest, timeSec: number): ThumbnailLocation {
  const raw = Number.isFinite(timeSec) ? Math.floor(timeSec / manifest.intervalSec) : 0;
  const index = Math.min(Math.max(raw, 0), manifest.thumbnailCount - 1);
  const withinSheet = index % manifest.tilesPerSheet;
  const sheetIndex = Math.floor(index / manifest.tilesPerSheet);
  const col = withinSheet % manifest.columns;
  const row = Math.floor(withinSheet / manifest.columns);
  return {
    index,
    sheet: manifest.sheets[sheetIndex] ?? manifest.sheets[manifest.sheets.length - 1] ?? '',
    x: col * manifest.thumbWidth,
    y: row * manifest.thumbHeight,
    width: manifest.thumbWidth,
    height: manifest.thumbHeight,
  };
}

// ---- Stream-URL builders ----------------------------------------------------

/**
 * The URL for one trickplay sprite sheet, carrying the streaming token so a
 * plain `background-image` (which cannot send a Bearer header) authenticates.
 * The token in the query also lets the browser cache each sheet by URL.
 */
export function trickplaySpriteUrl(mediaFileId: string, sprite: string, token: string): string {
  return `${API_BASE}/stream/trickplay/${encodeURIComponent(mediaFileId)}/${encodeURIComponent(
    sprite,
  )}?token=${encodeURIComponent(token)}`;
}

// ---- Requests ---------------------------------------------------------------

/**
 * GET /api/stream/trickplay/:mediaFileId/manifest — the tile map, or null when
 * no preview is available (404: trickplay disabled or unproducible for the
 * file). Token-authed via the query; skips the JWT silent-refresh.
 */
export async function getTrickplayManifest(
  mediaFileId: string,
  token: string,
): Promise<TrickplayManifest | null> {
  try {
    return await apiRequest<TrickplayManifest>(
      `/stream/trickplay/${encodeURIComponent(mediaFileId)}/manifest?token=${encodeURIComponent(
        token,
      )}`,
      { skipAuthRefresh: true },
    );
  } catch (error) {
    // A best-effort feature: an absent preview (404) is normal, not an error.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

// ---- Query keys -------------------------------------------------------------

export const trickplayKeys = {
  manifest: (mediaFileId: string) => ['player', 'trickplay', mediaFileId] as const,
};

// ---- Hooks ------------------------------------------------------------------

/**
 * The trickplay manifest for a media file, fetched once (never retried on a
 * missing preview, never refetched in the background). `data` is `null` when the
 * file has no trickplay, so the caller renders no scrub preview and the player
 * degrades gracefully. Enabled only once a streaming token is available.
 */
export function useTrickplayManifest(
  mediaFileId: string,
  token: string,
): UseQueryResult<TrickplayManifest | null> {
  return useQuery({
    queryKey: trickplayKeys.manifest(mediaFileId),
    queryFn: () => getTrickplayManifest(mediaFileId, token),
    enabled: mediaFileId !== '' && token !== '',
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
