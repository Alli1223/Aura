import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { ApiError } from './errors.js';

// Path-traversal defence for everything that touches the media filesystem.
// Library CRUD validates admin-supplied folder paths here; the scanner and
// streaming code reuse the same containment primitives so no file outside
// the configured MEDIA_ROOTS is ever read or served.
//
// All checks operate on fs.realpath-resolved paths — of the candidate AND of
// the roots — so symlinks inside a root that point outside of it are
// rejected, and a root that is itself a symlink still contains its children.

/** Error code carried by every path validation failure (HTTP 400). */
export const INVALID_PATH_CODE = 'INVALID_PATH';

function invalidPath(message: string): ApiError {
  return new ApiError(400, INVALID_PATH_CODE, message);
}

/**
 * True when `child` is `parent` or lives underneath it. Both arguments must
 * already be absolute, normalised paths (realpath output qualifies).
 */
export function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Realpath-resolves the configured media roots. Roots that do not exist are
 * dropped: a missing directory cannot contain anything, so keeping it would
 * only produce false containment matches against the unresolved path.
 */
async function resolveExistingRoots(mediaRoots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of mediaRoots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      // Root missing on this host — skip it.
    }
  }
  return resolved;
}

/**
 * Validates an admin-supplied library folder path and returns its canonical
 * (realpath) form, which is what must be stored and compared everywhere.
 *
 * Rejects with a 400 INVALID_PATH ApiError (reason-specific message) when the
 * path is not absolute, does not exist, is not a directory, or does not
 * resolve to a location inside one of the configured media roots (symlink
 * escapes therefore rejected).
 */
export async function validateLibraryPath(
  candidate: string,
  mediaRoots: readonly string[],
): Promise<string> {
  if (!path.isAbsolute(candidate)) {
    throw invalidPath(`Path "${candidate}" must be an absolute path`);
  }

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw invalidPath(`Path "${candidate}" does not exist`);
  }

  const stats = await stat(canonical);
  if (!stats.isDirectory()) {
    throw invalidPath(`Path "${candidate}" is not a directory`);
  }

  const roots = await resolveExistingRoots(mediaRoots);
  if (!roots.some((root) => isPathWithin(canonical, root))) {
    throw invalidPath(`Path "${candidate}" is outside the configured media roots`);
  }

  return canonical;
}

/** Result of re-validating a stored media file path at serve time. */
export type MediaFileResolution =
  | { ok: true; canonicalPath: string; stats: Stats }
  | { ok: false; reason: 'missing' | 'outside_roots' };

/**
 * Re-validates a stored media file path immediately before it is served.
 * The filesystem may have changed since the scan, so the stored path is
 * realpath-resolved fresh and its canonical form is checked for containment
 * in the configured media roots — a symlink swapped in after scanning
 * therefore cannot leak a file from outside the roots.
 *
 * Returns the canonical path callers must open (never the stored path — the
 * canonical form is the one that was containment-checked) plus its fresh
 * stats, or a typed rejection: `missing` when the path no longer resolves to
 * a regular file, `outside_roots` when it resolves somewhere unsafe. Never
 * throws for filesystem reasons.
 */
export async function resolveMediaFileForServing(
  storedPath: string,
  mediaRoots: readonly string[],
): Promise<MediaFileResolution> {
  let canonical: string;
  try {
    canonical = await realpath(storedPath);
  } catch {
    return { ok: false, reason: 'missing' };
  }

  const roots = await resolveExistingRoots(mediaRoots);
  if (!roots.some((root) => isPathWithin(canonical, root))) {
    return { ok: false, reason: 'outside_roots' };
  }

  let stats: Stats;
  try {
    stats = await stat(canonical);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (!stats.isFile()) return { ok: false, reason: 'missing' };

  return { ok: true, canonicalPath: canonical, stats };
}
