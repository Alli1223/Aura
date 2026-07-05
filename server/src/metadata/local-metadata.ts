import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { isPathWithin } from '../lib/media-roots.js';
import { yearFromDateString } from './tmdb-matcher.js';

// Local sidecar metadata: Kodi-style .nfo files and local artwork
// (poster.jpg / folder.jpg / fanart.jpg …) that live next to the media on
// disk. When present these OUTRANK the online agents — the enrich
// orchestrator (enrich-media.ts) reads local metadata after the online agents
// and overlays any NFO-provided field on top, so a curated .nfo always wins.
//
// Design rules:
//   - Never throw for expected conditions. parseNfo returns null on anything
//     it cannot parse; discovery returns null when no sidecar exists.
//   - Path safety: every candidate path is realpath-resolved and checked for
//     containment inside a configured media root before it is read or
//     returned — a symlink pointing outside the roots, or a decoy above a
//     root, can never be surfaced (the same rule media-roots.ts enforces).
//   - Tolerant parsing: NFOs are frequently malformed or carry a trailing URL
//     line. We slice to the first '<' … last '>' before parsing and swallow
//     parser errors. Values are sanitised (control chars stripped, lengths
//     capped) before they reach the database.
//   - Local artwork paths are stored as bare absolute path strings, distinct
//     from the `tmdb:` / `anilist:` URI schemes. The artwork-cache already
//     accepts an absolute local path whose realpath is inside a media root
//     (see artwork-cache.ts loadSource/readLocalImage) and resizes it, so no
//     new plumbing is needed to serve them.

/** Kodi NFO root element we know how to read. */
export type LocalItemType = 'movie' | 'show' | 'episode';

/** Local artwork role, mapped to a different filename precedence list. */
export type ArtworkKind = 'poster' | 'backdrop';

/** Normalised subset of a Kodi .nfo we can map onto a MediaItem. */
export interface ParsedNfo {
  title?: string;
  /** Original-language title. Parsed for completeness; the schema has no
   *  column for it, so the orchestrator does not persist it. */
  originalTitle?: string;
  year?: number;
  overview?: string;
  tagline?: string;
  runtimeMs?: number;
  communityRating?: number;
  contentRating?: string;
  genres: string[];
  tmdbId?: number;
  imdbId?: string;
}

/** Result of reading every local sidecar for one item. */
export interface LocalMetadata {
  nfo: ParsedNfo | null;
  /** Absolute local path of a discovered poster, if any. */
  posterPath?: string;
  /** Absolute local path of a discovered backdrop/fanart, if any. */
  backdropPath?: string;
}

/** NFOs are tiny; refuse to read anything larger (defence against a huge
 *  file dropped in place of an NFO). */
const MAX_NFO_BYTES = 5 * 1024 * 1024;

// Field length caps — curated NFOs are small; hostile ones are not.
const MAX_TITLE = 500;
const MAX_OVERVIEW = 20_000;
const MAX_TAGLINE = 1_000;
const MAX_CONTENT_RATING = 64;
const MAX_GENRE = 100;
const MAX_GENRES = 50;
const MAX_IMDB_ID = 32;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep every value a string; we parse numbers/dates ourselves so a value
  // like "2010" never becomes a float and lose its exact digits.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

// ---------------------------------------------------------------------------
// NFO parsing
// ---------------------------------------------------------------------------

/**
 * Parses a Kodi-style .nfo document (`<movie>`, `<tvshow>` or
 * `<episodedetails>` root). Returns a normalised ParsedNfo, or null when the
 * text is not recognisable XML with a known root. Never throws.
 */
export function parseNfo(xmlString: string): ParsedNfo | null {
  const xml = extractXml(xmlString);
  if (xml === null) return null;

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const doc = parsed as Record<string, unknown>;
  const root = (doc.movie ?? doc.tvshow ?? doc.episodedetails) as unknown;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return null;
  const r = root as Record<string, unknown>;

  const nfo: ParsedNfo = { genres: extractGenres(r.genre) };

  const title = sanitizeText(textOf(r.title), MAX_TITLE);
  if (title !== undefined) nfo.title = title;
  const originalTitle = sanitizeText(textOf(r.originaltitle), MAX_TITLE);
  if (originalTitle !== undefined) nfo.originalTitle = originalTitle;

  const year =
    intOf(r.year) ??
    yearFromDateString(textOf(r.premiered)) ??
    yearFromDateString(textOf(r.aired)) ??
    yearFromDateString(textOf(r.releasedate));
  if (year !== undefined) nfo.year = year;

  const overview = sanitizeText(textOf(r.plot), MAX_OVERVIEW);
  if (overview !== undefined) nfo.overview = overview;
  const tagline = sanitizeText(textOf(r.tagline), MAX_TAGLINE);
  if (tagline !== undefined) nfo.tagline = tagline;

  const runtimeMin = floatOf(r.runtime);
  if (runtimeMin !== undefined && runtimeMin > 0) nfo.runtimeMs = Math.round(runtimeMin * 60_000);

  const rating = extractRating(r);
  if (rating !== undefined && rating > 0) nfo.communityRating = rating;

  const contentRating = sanitizeText(stripRatedPrefix(textOf(r.mpaa)), MAX_CONTENT_RATING);
  if (contentRating !== undefined) nfo.contentRating = contentRating;

  const ids = extractIds(r);
  if (ids.tmdbId !== undefined) nfo.tmdbId = ids.tmdbId;
  if (ids.imdbId !== undefined) nfo.imdbId = ids.imdbId;

  return nfo;
}

/** Slices raw text to the first '<' … last '>' so a leading BOM/URL line or a
 *  trailing URL line cannot defeat the parser. Null when there is no markup. */
function extractXml(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('<');
  const end = raw.lastIndexOf('>');
  if (start === -1 || end === -1 || end < start) return null;
  const sliced = raw.slice(start, end + 1).trim();
  return sliced === '' ? null : sliced;
}

/** Text content of a node whether it is a bare string or an attributed
 *  object ({ '#text': … }). */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if ('#text' in rec) return textOf(rec['#text']);
  }
  return undefined;
}

function intOf(value: unknown): number | undefined {
  const text = textOf(value);
  if (text === undefined) return undefined;
  const match = /-?\d+/.exec(text);
  if (match === null) return undefined;
  const n = Number.parseInt(match[0], 10);
  return Number.isFinite(n) ? n : undefined;
}

function floatOf(value: unknown): number | undefined {
  const text = textOf(value);
  if (text === undefined) return undefined;
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (match === null) return undefined;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) ? n : undefined;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** mpaa strings arrive as "Rated PG-13", "US:PG-13" or "PG-13"; keep the
 *  certification. */
function stripRatedPrefix(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replace(/^\s*rated\s+/i, '')
    .replace(/^[A-Za-z]{2}:/, '')
    .trim();
}

/** Removes C0/C1 control characters (except tab/newline), normalises line
 *  endings, trims and caps the length. Returns undefined when nothing is left. */
function sanitizeText(value: string | undefined, maxLen: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .trim();
  if (cleaned === '') return undefined;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function extractGenres(value: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of toArray(value)) {
    const genre = sanitizeText(textOf(entry), MAX_GENRE);
    if (genre === undefined) continue;
    const key = genre.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(genre);
    if (out.length >= MAX_GENRES) break;
  }
  return out;
}

/** Community rating from `<rating>` (scalar or `<value>` child) or the modern
 *  `<ratings><rating default="true"><value>…` container. Assumes a 0-10 scale. */
function extractRating(root: Record<string, unknown>): number | undefined {
  const direct = root.rating;
  if (direct !== undefined) {
    if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) {
      const rec = direct as Record<string, unknown>;
      const value = floatOf(rec.value ?? rec['#text']);
      if (value !== undefined) return value;
    } else {
      const value = floatOf(direct);
      if (value !== undefined) return value;
    }
  }

  const ratings = root.ratings;
  if (typeof ratings === 'object' && ratings !== null) {
    const list = toArray((ratings as Record<string, unknown>).rating);
    const preferred =
      list.find(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>)['@_default'] === 'true',
      ) ?? list[0];
    if (typeof preferred === 'object' && preferred !== null) {
      const rec = preferred as Record<string, unknown>;
      const value = floatOf(rec.value ?? rec['#text']);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Resolves external ids with precedence: `<uniqueid type=…>` (explicit type)
 * first, then dedicated legacy `<tmdbid>`/`<imdbid>`, then a legacy `<id>`
 * (imdb when it looks like "tt…", tmdb when purely numeric).
 */
function extractIds(root: Record<string, unknown>): { tmdbId?: number; imdbId?: string } {
  let tmdbId: number | undefined;
  let imdbId: string | undefined;

  for (const entry of toArray(root.uniqueid)) {
    if (typeof entry === 'string') {
      const value = entry.trim();
      if (imdbId === undefined && /^tt\d+$/i.test(value)) imdbId = value;
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const type = textOf(rec['@_type'])?.toLowerCase();
    const value = textOf(rec['#text'])?.trim();
    if (value === undefined || value === '') continue;
    if (type === 'tmdb' && tmdbId === undefined) {
      const n = intOf(value);
      if (n !== undefined) tmdbId = n;
    } else if (type === 'imdb' && imdbId === undefined) {
      imdbId = value;
    }
  }

  if (tmdbId === undefined) {
    const n = intOf(root.tmdbid);
    if (n !== undefined) tmdbId = n;
  }
  if (imdbId === undefined) {
    const value = textOf(root.imdbid)?.trim();
    if (value !== undefined && value !== '') imdbId = value;
  }

  const idText = textOf(root.id)?.trim();
  if (idText !== undefined && idText !== '') {
    if (/^tt\d+$/i.test(idText)) {
      if (imdbId === undefined) imdbId = idText;
    } else if (/^\d+$/.test(idText) && tmdbId === undefined) {
      tmdbId = Number.parseInt(idText, 10);
    }
  }

  return { tmdbId, imdbId: sanitizeText(imdbId, MAX_IMDB_ID) };
}

// ---------------------------------------------------------------------------
// Sidecar discovery (path-safe)
// ---------------------------------------------------------------------------

/** `/dir/Movie (2010).mkv` -> `Movie (2010)`. */
function basenameNoExt(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  return ext === '' ? base : base.slice(0, base.length - ext.length);
}

/**
 * Returns `candidate` when it exists, is a regular file and its realpath is
 * contained in one of `mediaRoots`; otherwise null. The original (uncanonical)
 * path is returned so stored paths stay human-readable, but containment is
 * always checked against the realpath so symlink escapes are rejected.
 */
async function resolveWithinRoots(
  candidate: string,
  mediaRoots: readonly string[],
): Promise<string | null> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    return null;
  }

  let contained = false;
  for (const root of mediaRoots) {
    try {
      if (isPathWithin(canonical, await realpath(root))) {
        contained = true;
        break;
      }
    } catch {
      // Root missing on this host — cannot contain anything.
    }
  }
  if (!contained) return null;

  try {
    const stats = await stat(canonical);
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

/**
 * Finds the .nfo for a movie or episode video file: `<basename>.nfo` first,
 * then `movie.nfo` in the same directory for movies. Returns the absolute path
 * (inside a media root) or null.
 */
export async function findNfoForFile(
  videoAbsPath: string,
  itemType: 'movie' | 'episode',
  mediaRoots: readonly string[],
): Promise<string | null> {
  const dir = path.dirname(videoAbsPath);
  const candidates = [path.join(dir, `${basenameNoExt(videoAbsPath)}.nfo`)];
  if (itemType === 'movie') candidates.push(path.join(dir, 'movie.nfo'));

  for (const candidate of candidates) {
    const resolved = await resolveWithinRoots(candidate, mediaRoots);
    if (resolved !== null) return resolved;
  }
  return null;
}

/** Finds `tvshow.nfo` in a show's folder (inside a media root), or null. */
export async function findShowNfo(
  showDir: string,
  mediaRoots: readonly string[],
): Promise<string | null> {
  return resolveWithinRoots(path.join(showDir, 'tvshow.nfo'), mediaRoots);
}

/**
 * Finds local artwork of `kind` in `dir`, trying Kodi's conventional
 * filenames in priority order. `videoBasename` (when given) enables the
 * per-file `<basename>-poster.jpg` / `<basename>-fanart.jpg` variants.
 * Returns the absolute path (inside a media root) or null.
 */
export async function findLocalArtwork(
  dir: string,
  kind: ArtworkKind,
  videoBasename: string | undefined,
  mediaRoots: readonly string[],
): Promise<string | null> {
  const names =
    kind === 'poster'
      ? [
          'poster.jpg',
          'poster.png',
          'folder.jpg',
          'folder.png',
          videoBasename === undefined ? undefined : `${videoBasename}-poster.jpg`,
          videoBasename === undefined ? undefined : `${videoBasename}-poster.png`,
          'cover.jpg',
          'cover.png',
        ]
      : [
          'fanart.jpg',
          'fanart.png',
          'backdrop.jpg',
          'backdrop.png',
          videoBasename === undefined ? undefined : `${videoBasename}-fanart.jpg`,
          videoBasename === undefined ? undefined : `${videoBasename}-fanart.png`,
        ];

  for (const name of names) {
    if (name === undefined) continue;
    const resolved = await resolveWithinRoots(path.join(dir, name), mediaRoots);
    if (resolved !== null) return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Combined read
// ---------------------------------------------------------------------------

async function readNfo(nfoPath: string): Promise<ParsedNfo | null> {
  try {
    const stats = await stat(nfoPath);
    if (!stats.isFile() || stats.size > MAX_NFO_BYTES) return null;
    return parseNfo(await readFile(nfoPath, 'utf-8'));
  } catch {
    return null;
  }
}

export interface ReadLocalMetadataOptions {
  /** Video file path for a movie or episode (its directory is searched). */
  videoPath?: string;
  /** Show folder for a show (searched for tvshow.nfo + artwork). */
  showDir?: string;
  itemType: LocalItemType;
  mediaRoots: readonly string[];
}

/**
 * Reads the NFO and local artwork for one item. Everything is path-safe
 * (confined to the media roots) and never throws — missing sidecars simply
 * yield `{ nfo: null }` with no artwork.
 */
export async function readLocalMetadata(opts: ReadLocalMetadataOptions): Promise<LocalMetadata> {
  const { itemType, videoPath, showDir, mediaRoots } = opts;

  let dir: string | undefined;
  let videoBasename: string | undefined;
  let nfoPath: string | null = null;

  if (itemType === 'show') {
    if (showDir === undefined) return { nfo: null };
    dir = showDir;
    nfoPath = await findShowNfo(showDir, mediaRoots);
  } else {
    if (videoPath === undefined) return { nfo: null };
    dir = path.dirname(videoPath);
    videoBasename = basenameNoExt(videoPath);
    nfoPath = await findNfoForFile(videoPath, itemType, mediaRoots);
  }

  const nfo = nfoPath === null ? null : await readNfo(nfoPath);
  const posterPath = await findLocalArtwork(dir, 'poster', videoBasename, mediaRoots);
  const backdropPath = await findLocalArtwork(dir, 'backdrop', videoBasename, mediaRoots);

  return {
    nfo,
    posterPath: posterPath ?? undefined,
    backdropPath: backdropPath ?? undefined,
  };
}
