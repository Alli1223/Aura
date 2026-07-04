import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiError } from './errors.js';
import { isPathWithin, validateLibraryPath, INVALID_PATH_CODE } from './media-roots.js';

// Unit tests against a real temporary directory tree (including real
// symlinks) — this module is the path-traversal seam, so the checks are
// exercised on the actual filesystem, not mocks.

let tempDir: string; // canonical (realpath) temp dir
let root: string; //    <tempDir>/media       — the configured media root
let outside: string; // <tempDir>/outside     — exists, but not under root

async function expectInvalidPath(candidate: string, messagePattern: RegExp): Promise<void> {
  const promise = validateLibraryPath(candidate, [root]);
  await expect(promise, candidate).rejects.toBeInstanceOf(ApiError);
  await expect(promise, candidate).rejects.toMatchObject({
    statusCode: 400,
    code: INVALID_PATH_CODE,
    message: expect.stringMatching(messagePattern) as string,
  });
}

beforeAll(async () => {
  // realpath the temp dir itself: on some platforms tmpdir() is a symlink
  // (e.g. /var -> /private/var) and assertions compare canonical forms.
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-media-roots-')));
  root = path.join(tempDir, 'media');
  outside = path.join(tempDir, 'outside');
  await mkdir(path.join(root, 'movies'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'movie.mkv'), 'not a directory');
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('isPathWithin', () => {
  it('accepts the parent itself and true descendants', () => {
    expect(isPathWithin('/media', '/media')).toBe(true);
    expect(isPathWithin('/media/movies', '/media')).toBe(true);
    expect(isPathWithin('/media/a/b/c', '/media')).toBe(true);
  });

  it('rejects siblings, prefix lookalikes and parents', () => {
    expect(isPathWithin('/mnt', '/media')).toBe(false);
    expect(isPathWithin('/media-evil', '/media')).toBe(false);
    expect(isPathWithin('/media-evil/movies', '/media')).toBe(false);
    expect(isPathWithin('/', '/media')).toBe(false);
    expect(isPathWithin('/media/..', '/media')).toBe(false);
  });
});

describe('validateLibraryPath', () => {
  it('returns the canonical form of a valid directory', async () => {
    const messy = `${path.join(root, 'movies', '..', 'movies')}${path.sep}`;
    await expect(validateLibraryPath(messy, [root])).resolves.toBe(path.join(root, 'movies'));
  });

  it('accepts a media root itself and paths in any configured root', async () => {
    await expect(validateLibraryPath(root, [root])).resolves.toBe(root);
    await expect(validateLibraryPath(outside, [root, outside])).resolves.toBe(outside);
  });

  it('resolves a symlink pointing inside the roots to its target', async () => {
    const link = path.join(root, 'movies-link');
    await symlink(path.join(root, 'movies'), link);
    await expect(validateLibraryPath(link, [root])).resolves.toBe(path.join(root, 'movies'));
  });

  it('accepts children of a root that is itself a symlink', async () => {
    const rootLink = path.join(tempDir, 'media-link');
    await symlink(root, rootLink);
    await expect(validateLibraryPath(path.join(rootLink, 'movies'), [rootLink])).resolves.toBe(
      path.join(root, 'movies'),
    );
  });

  it('rejects relative paths', async () => {
    await expectInvalidPath('movies', /absolute/);
    await expectInvalidPath('./movies', /absolute/);
  });

  it('rejects paths that do not exist', async () => {
    await expectInvalidPath(path.join(root, 'missing'), /does not exist/);
  });

  it('rejects files (not directories)', async () => {
    await expectInvalidPath(path.join(root, 'movie.mkv'), /not a directory/);
  });

  it('rejects existing directories outside every media root', async () => {
    await expectInvalidPath(outside, /outside the configured media roots/);
    await expectInvalidPath(tempDir, /outside the configured media roots/);
  });

  it('rejects a symlink inside a root that points outside (escape)', async () => {
    const escape = path.join(root, 'sneaky');
    await symlink(outside, escape);
    await expectInvalidPath(escape, /outside the configured media roots/);
  });

  it('rejects traversal that climbs out of the root', async () => {
    await expectInvalidPath(path.join(root, '..', 'outside'), /outside the configured media roots/);
  });

  it('rejects everything when no configured root exists', async () => {
    await expect(
      validateLibraryPath(path.join(root, 'movies'), [path.join(tempDir, 'missing-root')]),
    ).rejects.toMatchObject({ code: INVALID_PATH_CODE });
  });
});
