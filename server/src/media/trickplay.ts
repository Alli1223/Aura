import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { resolveMediaFileForServing } from '../lib/media-roots.js';

// Trickplay (BIF-style scrub-preview) sprite generation.
//
// For one video file we produce a small set of JPEG sprite SHEETS — a grid of
// evenly-spaced thumbnails, one frame every `intervalSec` seconds — plus a JSON
// manifest that maps a scrub time to the sheet + tile a client should draw. The
// player renders the tile at the current seek position as a hover preview.
//
// Generation is two ffmpeg passes (never a shell — argument arrays only):
//   1. extract one scaled thumbnail every `intervalSec` seconds to a temp dir;
//   2. tile the numbered thumbnails into fixed-size grids (sprite sheets).
// The two-pass shape makes the thumbnail COUNT exact (it is the number of files
// pass 1 produced, read back from disk), so the manifest math is never a guess
// about how many frames ffmpeg's `fps` filter emitted.
//
// Output lives under `${CONFIG_DIR}/cache/trickplay/<mediaFileId>/`:
//   sprite-0.jpg, sprite-1.jpg, ...   the sheets
//   manifest.json                     the tile map + a freshness key
// Writes are atomic: everything is built in a sibling temp dir and renamed into
// place, so a crashed/failed generation never leaves a half-written set behind.
//
// Idempotency: the manifest records the source file's size + mtime. A cached
// manifest whose key matches the current file is reused without re-running
// ffmpeg; a changed file (new size/mtime) regenerates.
//
// SECURITY (see CLAUDE.md):
//  - ffmpeg is spawned with an argument array, never a shell string.
//  - The input path is re-validated inside a configured media root immediately
//    before ffmpeg reads it (resolveMediaFileForServing).
//  - The mediaFileId and every sprite filename are validated against strict
//    patterns before they are joined into a cache path, and the resolved path
//    is asserted to stay inside the cache directory, so neither can traverse.

const execFileAsync = promisify(execFile);

/** Manifest filename inside a media file's trickplay directory. */
export const TRICKPLAY_MANIFEST_NAME = 'manifest.json';

/** Manifest schema version; bumped if the on-disk shape ever changes. */
const MANIFEST_VERSION = 1;

/** Default seconds between preview thumbnails. */
export const DEFAULT_TRICKPLAY_INTERVAL_SEC = 10;

/** Default preview thumbnail width in pixels. */
export const DEFAULT_TRICKPLAY_THUMB_WIDTH = 320;

/** Time budget for one ffmpeg pass — a long film decodes for a while. */
export const DEFAULT_TRICKPLAY_TIMEOUT_MS = 10 * 60_000;

/** JPEG quality (ffmpeg `-q:v`, 2 best … 31 worst); 4 is crisp but compact. */
const JPEG_QUALITY = 4;

/** Max columns per sprite sheet. */
const SPRITE_COLUMNS = 10;
/** Max rows per sprite sheet (so at most SPRITE_COLUMNS*SPRITE_ROWS tiles). */
const SPRITE_ROWS = 10;

/** A media file id used as a cache directory name — never a path fragment. */
const MEDIA_FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The only sprite filenames this module ever writes or serves. */
export const SPRITE_FILE_PATTERN = /^sprite-\d{1,6}\.jpg$/;

/** Frame files produced by the extraction pass. */
const FRAME_FILE_PATTERN = /^frame-\d+\.jpg$/;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * The tile map for one media file's trickplay sprites. A client maps a scrub
 * time to a thumbnail with `index = floor(time / intervalSec)` (clamped to
 * `[0, thumbnailCount-1]`), then `sheet = floor(index / tilesPerSheet)`,
 * `withinSheet = index % tilesPerSheet`, `col = withinSheet % columns`,
 * `row = floor(withinSheet / columns)`, and draws `sheets[sheet]` at pixel
 * offset `(col*thumbWidth, row*thumbHeight)` sized `thumbWidth x thumbHeight`.
 * See locateThumbnail, which is that math.
 */
export interface TrickplayManifest {
  version: number;
  mediaFileId: string;
  /** Source size (bytes) at generation time — half of the freshness key. */
  sourceSize: number;
  /** Source mtime (ms) at generation time — half of the freshness key. */
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

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  mediaFileId: z.string().min(1),
  sourceSize: z.number().int().nonnegative(),
  sourceMtimeMs: z.number().int().nonnegative(),
  intervalSec: z.number().int().positive(),
  thumbWidth: z.number().int().positive(),
  thumbHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  tilesPerSheet: z.number().int().positive(),
  thumbnailCount: z.number().int().positive(),
  sheets: z.array(z.string().regex(SPRITE_FILE_PATTERN)).min(1),
});

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

/**
 * Resolves a scrub time (seconds) to the thumbnail a client should draw. The
 * canonical implementation of the manifest math; exported so both the player
 * and the tests share one source of truth.
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
    sheet: manifest.sheets[sheetIndex] ?? manifest.sheets[manifest.sheets.length - 1]!,
    x: col * manifest.thumbWidth,
    y: row * manifest.thumbHeight,
    width: manifest.thumbWidth,
    height: manifest.thumbHeight,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TrickplayUnavailableReason =
  /** The source file no longer resolves to a real file. */
  | 'input-missing'
  /** The source path resolves outside the configured media roots. */
  | 'input-outside-roots'
  /** The file has no usable width/height, so tile size cannot be computed. */
  | 'no-dimensions'
  /** ffmpeg produced no thumbnails (empty/unsupported video). */
  | 'no-frames'
  /** ffmpeg failed to run. */
  | 'ffmpeg-failed';

/**
 * Thrown when trickplay cannot be produced for a file. The serving route maps
 * every reason to a cloaked 404 (a preview is best-effort, never an error the
 * client must handle specially).
 */
export class TrickplayUnavailableError extends Error {
  readonly reason: TrickplayUnavailableReason;
  readonly mediaFileId: string;
  constructor(reason: TrickplayUnavailableReason, mediaFileId: string, message?: string) {
    super(message ?? `Trickplay unavailable for "${mediaFileId}" (${reason})`);
    this.name = 'TrickplayUnavailableError';
    this.reason = reason;
    this.mediaFileId = mediaFileId;
  }
}

// ---------------------------------------------------------------------------
// Inputs & options
// ---------------------------------------------------------------------------

/** The media file trickplay is generated for. */
export interface TrickplayFile {
  /** MediaFile id — the cache directory name. */
  id: string;
  /** Absolute path to the video, as stored on the MediaFile row. */
  path: string;
  /** Source video width/height (from ffprobe); both required to size tiles. */
  width: number | null;
  height: number | null;
  /** File size in bytes and mtime in ms — the freshness key. */
  sizeBytes: number;
  mtimeMs: number;
}

/** Runs one ffmpeg invocation. Injectable so tests can count/stub the calls. */
export type FfmpegRunner = (
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<void>;

/** The default runner: spawns ffmpeg with an argument array (never a shell). */
export const ffmpegRunner: FfmpegRunner = async (ffmpegPath, args, timeoutMs) => {
  await execFileAsync(ffmpegPath, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL' });
};

export interface TrickplayOptions {
  /** Trickplay cache root, e.g. `${CONFIG_DIR}/cache/trickplay`. */
  cacheRoot: string;
  /** Configured media roots; the source must resolve inside one. */
  mediaRoots: readonly string[];
  /** Seconds between thumbnails. Defaults to DEFAULT_TRICKPLAY_INTERVAL_SEC. */
  intervalSec?: number;
  /** Thumbnail width. Defaults to DEFAULT_TRICKPLAY_THUMB_WIDTH. */
  thumbWidth?: number;
  /** ffmpeg binary. Defaults to FFMPEG_PATH env or "ffmpeg". */
  ffmpegPath?: string;
  /** Per-pass time budget. Defaults to DEFAULT_TRICKPLAY_TIMEOUT_MS. */
  timeoutMs?: number;
  /** ffmpeg runner injection point (tests). Defaults to the real runner. */
  runFfmpeg?: FfmpegRunner;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** The trickplay cache root under a config directory. */
export function trickplayCacheRoot(configDir: string): string {
  return path.join(configDir, 'cache', 'trickplay');
}

/**
 * The directory holding one media file's sprites + manifest, or undefined when
 * the id is not a bare token (defence in depth: an id is never a path fragment).
 */
function fileDir(cacheRoot: string, mediaFileId: string): string | undefined {
  if (!MEDIA_FILE_ID_PATTERN.test(mediaFileId)) return undefined;
  const dir = path.join(cacheRoot, mediaFileId);
  if (path.dirname(path.resolve(dir)) !== path.resolve(cacheRoot)) return undefined;
  return dir;
}

/**
 * Resolves the on-disk path of a sprite sheet, validating BOTH the id and the
 * sprite filename so neither can traverse out of the cache. Returns undefined
 * for anything that fails the allowlist (the caller treats it as "not found").
 */
export function resolveSpritePath(
  cacheRoot: string,
  mediaFileId: string,
  spriteName: string,
): string | undefined {
  if (!SPRITE_FILE_PATTERN.test(spriteName)) return undefined;
  const dir = fileDir(cacheRoot, mediaFileId);
  if (dir === undefined) return undefined;
  const filePath = path.join(dir, spriteName);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) return undefined;
  return filePath;
}

// ---------------------------------------------------------------------------
// Manifest read + freshness
// ---------------------------------------------------------------------------

/** Reads and validates a media file's manifest, or undefined when absent/bad. */
export async function readTrickplayManifest(
  cacheRoot: string,
  mediaFileId: string,
): Promise<TrickplayManifest | undefined> {
  const dir = fileDir(cacheRoot, mediaFileId);
  if (dir === undefined) return undefined;
  let raw: string;
  try {
    raw = await readFile(path.join(dir, TRICKPLAY_MANIFEST_NAME), 'utf8');
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = manifestSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a cached manifest still matches the file's current size + mtime. */
function isManifestFresh(manifest: TrickplayManifest, file: TrickplayFile): boolean {
  return (
    manifest.sourceSize === file.sizeBytes && manifest.sourceMtimeMs === Math.round(file.mtimeMs)
  );
}

// ---------------------------------------------------------------------------
// Layout + generation
// ---------------------------------------------------------------------------

interface TileLayout {
  columns: number;
  rows: number;
  tilesPerSheet: number;
  sheets: number;
}

/**
 * Grid for `count` thumbnails: a tight single sheet for small counts, capped at
 * SPRITE_COLUMNS x SPRITE_ROWS tiles per sheet with as many sheets as needed
 * beyond that. Every sheet is a uniform `columns x rows` grid (the last may be
 * padded); `thumbnailCount` in the manifest says how many tiles are real.
 */
function tileLayout(count: number): TileLayout {
  const columns = Math.min(SPRITE_COLUMNS, count);
  const rows = Math.min(SPRITE_ROWS, Math.ceil(count / columns));
  const tilesPerSheet = columns * rows;
  const sheets = Math.ceil(count / tilesPerSheet);
  return { columns, rows, tilesPerSheet, sheets };
}

/** Even thumbnail height preserving the source aspect (yuv420p needs even). */
function thumbHeightFor(thumbWidth: number, width: number, height: number): number {
  const raw = (thumbWidth * height) / width;
  return Math.max(2, 2 * Math.round(raw / 2));
}

/**
 * Ensures a media file has an up-to-date trickplay sprite set and returns its
 * manifest. A fresh cached manifest (matching size + mtime) is reused without
 * running ffmpeg; otherwise the sprites are (re)generated. Throws
 * TrickplayUnavailableError when a preview cannot be produced (input gone or
 * outside the media roots, unknown dimensions, or ffmpeg failure).
 */
export async function ensureTrickplay(
  file: TrickplayFile,
  options: TrickplayOptions,
): Promise<TrickplayManifest> {
  const cached = await readTrickplayManifest(options.cacheRoot, file.id);
  if (cached !== undefined && isManifestFresh(cached, file)) return cached;
  return generateTrickplay(file, options);
}

/**
 * (Re)generates a media file's trickplay sprites + manifest unconditionally and
 * returns the manifest. Prefer ensureTrickplay, which skips this when the cache
 * is already fresh.
 */
export async function generateTrickplay(
  file: TrickplayFile,
  options: TrickplayOptions,
): Promise<TrickplayManifest> {
  const dir = fileDir(options.cacheRoot, file.id);
  if (dir === undefined) throw new TrickplayUnavailableError('no-frames', file.id, 'invalid id');

  if (file.width === null || file.width <= 0 || file.height === null || file.height <= 0) {
    throw new TrickplayUnavailableError('no-dimensions', file.id);
  }

  // Re-validate the source inside a media root immediately before ffmpeg reads
  // it (a symlink swapped in after scanning cannot escape).
  const resolution = await resolveMediaFileForServing(file.path, options.mediaRoots);
  if (!resolution.ok) {
    throw new TrickplayUnavailableError(
      resolution.reason === 'missing' ? 'input-missing' : 'input-outside-roots',
      file.id,
    );
  }
  const inputPath = resolution.canonicalPath;

  const intervalSec = options.intervalSec ?? DEFAULT_TRICKPLAY_INTERVAL_SEC;
  const thumbWidth = options.thumbWidth ?? DEFAULT_TRICKPLAY_THUMB_WIDTH;
  const thumbHeight = thumbHeightFor(thumbWidth, file.width, file.height);
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRICKPLAY_TIMEOUT_MS;
  const run = options.runFfmpeg ?? ffmpegRunner;

  await mkdir(options.cacheRoot, { recursive: true });
  const work = path.join(options.cacheRoot, `.tmp-${file.id}-${randomUUID()}`);
  const framesDir = path.join(work, 'frames');
  await mkdir(framesDir, { recursive: true });

  try {
    // Pass 1: one scaled thumbnail every `intervalSec` seconds.
    // prettier-ignore
    const extractArgs = [
      '-nostdin', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-vf', `fps=1/${intervalSec},scale=${thumbWidth}:${thumbHeight}`,
      '-an', '-sn', '-dn',
      '-q:v', String(JPEG_QUALITY),
      '-start_number', '0',
      path.join(framesDir, 'frame-%05d.jpg'),
    ];
    await runFfmpegPass(run, ffmpegPath, extractArgs, timeoutMs, file.id);

    const frameFiles = (await readdir(framesDir)).filter((name) => FRAME_FILE_PATTERN.test(name));
    const thumbnailCount = frameFiles.length;
    if (thumbnailCount === 0) throw new TrickplayUnavailableError('no-frames', file.id);

    const layout = tileLayout(thumbnailCount);

    // Pass 2: tile the numbered thumbnails into fixed grids (sprite sheets).
    // prettier-ignore
    const tileArgs = [
      '-nostdin', '-loglevel', 'error', '-y',
      '-framerate', '1', '-start_number', '0',
      '-i', path.join(framesDir, 'frame-%05d.jpg'),
      '-vf', `tile=${layout.columns}x${layout.rows}`,
      '-q:v', String(JPEG_QUALITY),
      '-start_number', '0',
      path.join(work, 'sprite-%d.jpg'),
    ];
    await runFfmpegPass(run, ffmpegPath, tileArgs, timeoutMs, file.id);

    const sheets = (await readdir(work))
      .filter((name) => SPRITE_FILE_PATTERN.test(name))
      .sort((a, b) => spriteIndex(a) - spriteIndex(b));
    if (sheets.length === 0) throw new TrickplayUnavailableError('no-frames', file.id);

    const manifest: TrickplayManifest = {
      version: MANIFEST_VERSION,
      mediaFileId: file.id,
      sourceSize: file.sizeBytes,
      sourceMtimeMs: Math.round(file.mtimeMs),
      intervalSec,
      thumbWidth,
      thumbHeight,
      columns: layout.columns,
      rows: layout.rows,
      tilesPerSheet: layout.tilesPerSheet,
      thumbnailCount,
      sheets,
    };
    await writeFile(path.join(work, TRICKPLAY_MANIFEST_NAME), JSON.stringify(manifest), 'utf8');

    // Drop the intermediate frames so only sprites + manifest are published,
    // then swap the finished set into place atomically (rm old, rename temp).
    await rm(framesDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rename(work, dir);
    return manifest;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The numeric part of a `sprite-<n>.jpg` filename (for ordering sheets). */
function spriteIndex(name: string): number {
  const match = /(\d+)/.exec(name);
  return match === null ? 0 : Number(match[1]);
}

/** Runs one ffmpeg pass, mapping any spawn/exit failure to a typed error. */
async function runFfmpegPass(
  run: FfmpegRunner,
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number,
  mediaFileId: string,
): Promise<void> {
  try {
    await run(ffmpegPath, args, timeoutMs);
  } catch (cause) {
    throw new TrickplayUnavailableError(
      'ffmpeg-failed',
      mediaFileId,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}
