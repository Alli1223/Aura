import path from 'node:path';

import type { Library } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import type { LibraryType } from '../db/constants.js';
import { validateLibraryPath } from './media-roots.js';

// First-run convenience: the Docker image documents /media/{movies,tv,anime,
// recordings,other} as the default mounts, so an empty server seeds a library
// for each of those folders that actually exists. No user is granted access
// to the seeded libraries — admins see everything anyway and grants are
// always explicit.

interface DefaultLibrary {
  name: string;
  type: LibraryType;
  /** Folder name under the first media root. */
  dir: string;
}

export const DEFAULT_LIBRARIES: readonly DefaultLibrary[] = [
  { name: 'Movies', type: 'movies', dir: 'movies' },
  { name: 'TV Shows', type: 'tv', dir: 'tv' },
  { name: 'Anime', type: 'anime', dir: 'anime' },
  { name: 'Personal Recordings', type: 'recordings', dir: 'recordings' },
  { name: 'Other', type: 'other', dir: 'other' },
];

/**
 * Seeds the five default libraries. Idempotent: does nothing unless the
 * Library table is completely empty (a deleted default stays deleted), and
 * only creates libraries whose directory `<first media root>/<dir>` exists —
 * missing folders are skipped with a log line, never created on disk.
 *
 * Called at server startup and exported for tests. Returns the libraries it
 * created (empty when it was a no-op).
 */
export async function seedDefaultLibraries(
  mediaRoots: readonly string[],
  log?: FastifyBaseLogger,
): Promise<Library[]> {
  const prisma = getPrisma();

  const existing = await prisma.library.count();
  if (existing > 0) return [];

  const root = mediaRoots[0];
  if (root === undefined) return [];

  const created: Library[] = [];
  for (const entry of DEFAULT_LIBRARIES) {
    const dir = path.join(root, entry.dir);
    let canonical: string;
    try {
      // Reuses the same validation as the admin API: existing directory
      // inside the media roots, stored in canonical realpath form.
      canonical = await validateLibraryPath(dir, mediaRoots);
    } catch {
      log?.info({ path: dir }, `skipping default library "${entry.name}": directory not usable`);
      continue;
    }
    const library = await prisma.library.create({
      data: { name: entry.name, type: entry.type, paths: { create: { path: canonical } } },
    });
    log?.info({ path: canonical }, `seeded default library "${entry.name}" (${entry.type})`);
    created.push(library);
  }
  return created;
}
