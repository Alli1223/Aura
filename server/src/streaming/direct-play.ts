import path from 'node:path';

// Pure HTTP plumbing for the direct-play streaming endpoint: content-type
// mapping, Range header resolution, ETag construction/comparison and the
// Content-Disposition value. Everything here is deterministic and
// filesystem-free so the byte-range logic can be unit-tested exhaustively;
// the route (routes/stream.ts) owns auth, path safety and the actual I/O.

/**
 * Container extension → MIME type for the Content-Type header. Streaming
 * covers video containers only; anything unrecognised falls back to
 * application/octet-stream, which browsers will still range-request.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ogv': 'video/ogg',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Content-Type for a media file path, chosen by extension. */
export function contentTypeForPath(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Outcome of resolving a Range request header against a file size.
 *
 * - `full`: serve the whole file with 200. Used when there is no Range
 *   header AND when the header is malformed — RFC 9110 §14.2 says an invalid
 *   byte-range-set MUST be ignored, so malformed never errors.
 * - `range`: serve bytes [start, end] (inclusive) with 206.
 * - `unsatisfiable`: respond 416 with a star Content-Range carrying the size.
 */
export type RangeResolution =
  | { kind: 'full' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/** `start-end`, `start-` (open ended) — both positions decimal integers. */
const BOUNDED_RANGE_PATTERN = /^(\d+)-(\d*)$/;
/** `-suffix`: the final `suffix` bytes of the file. */
const SUFFIX_RANGE_PATTERN = /^-(\d+)$/;

/**
 * Resolves a Range request header against the current file size.
 *
 * Multi-range requests (`bytes=0-1,5-9`) resolve to the FIRST range only —
 * a deliberate simplification (single-part 206, no multipart/byteranges
 * body), matching what video players actually need and what most media
 * servers do. Ranges are clamped to the file, so an end past EOF serves up
 * to the final byte, and a suffix longer than the file serves the whole
 * file (as 206, per RFC 9110).
 */
export function resolveRequestRange(header: string | undefined, size: number): RangeResolution {
  if (header === undefined) return { kind: 'full' };

  // Only the bytes unit is understood; other units are ignored (=> 200).
  const match = /^bytes\s*=\s*(.*)$/i.exec(header.trim());
  if (match === null) return { kind: 'full' };

  // First non-empty byte-range-spec; RFC list grammar tolerates empty
  // elements around commas.
  const spec = (match[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (spec === undefined) return { kind: 'full' };

  const bounded = BOUNDED_RANGE_PATTERN.exec(spec);
  if (bounded !== null) {
    const start = Number(bounded[1]);
    const rawEnd = bounded[2] ?? '';
    const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    // last-byte-pos < first-byte-pos makes the spec syntactically invalid,
    // which invalidates the whole set => ignore the header entirely.
    if (rawEnd !== '' && Number(rawEnd) < start) return { kind: 'full' };
    if (start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'range', start, end };
  }

  const suffix = SUFFIX_RANGE_PATTERN.exec(spec);
  if (suffix !== null) {
    const length = Number(suffix[1]);
    // A zero-length suffix (and any suffix of an empty file) selects no
    // bytes: unsatisfiable.
    if (length === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(size - length, 0), end: size - 1 };
  }

  return { kind: 'full' };
}

/**
 * Weak ETag derived from what a byte-serving response actually depends on:
 * file size and mtime. Weak because two files with equal size+mtime are only
 * semantically (not guaranteed byte-) identical, and because it keeps the
 * If-None-Match comparison honest.
 */
export function computeEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.floor(mtimeMs)}"`;
}

/** Strips a weak-validator prefix so comparisons are RFC 9110 weak matches. */
function opaqueTag(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * True when an If-None-Match request header matches the given ETag (weak
 * comparison, per RFC 9110 §13.1.2 — If-None-Match always compares weakly).
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const header = ifNoneMatch.trim();
  if (header === '*') return true;
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate.length > 0 && opaqueTag(candidate) === opaqueTag(etag));
}

/**
 * `inline` Content-Disposition (play in the browser, don't download) naming
 * the file. The quoted fallback strips quotes/backslashes/control characters
 * and non-ASCII; the RFC 8187 `filename*` parameter carries the exact
 * UTF-8 name for clients that understand it.
 */
export function contentDispositionInline(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
