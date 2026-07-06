import { execFile, execSync } from 'node:child_process';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import { probeFile } from '../media/ffprobe.js';
import {
  scanLibrary,
  toSortTitle,
  type ProbeFn,
  type ScanStats,
  type TrickplayScanFile,
  type TrickplayScanHook,
} from './scan.js';

// End-to-end scanner tests against a real temporary SQLite database and a
// real fixture tree of tiny videos generated with ffmpeg (same approach as
// the media/ffprobe tests). ffmpeg/ffprobe are hard requirements of this
// project; the suite fails loudly if they are missing.

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

let tempDir: string; // canonical (realpath) temp dir
let mediaRoot: string; // the single configured media root
let moviesRoot: string;
let tvRoot: string;
let animeRoot: string;
let videoMaster: string; // tiny mkv: h264 video + aac audio
let audioMaster: string; // mkv containing only an audio stream
let prisma: PrismaClient;

let moviesLibraryId: string;
let tvLibraryId: string;
let animeLibraryId: string;

// Notable fixture paths reused across tests.
let movie1080: string;
let movie2160: string;
let matrixFile: string;

/** Wraps the real probe, recording which paths get probed. */
function countingProbe(): { probe: ProbeFn; paths: string[] } {
  const paths: string[] = [];
  const probe: ProbeFn = async (absPath) => {
    paths.push(absPath);
    return probeFile(absPath);
  };
  return { probe, paths };
}

function scan(libraryId: string, probe?: ProbeFn): Promise<ScanStats> {
  return scanLibrary(libraryId, { mediaRoots: [mediaRoot], ...(probe ? { probe } : {}) });
}

async function createLibrary(name: string, type: string, roots: string[]): Promise<string> {
  const library = await prisma.library.create({
    data: { name, type, paths: { create: roots.map((root) => ({ path: root })) } },
  });
  return library.id;
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-scan-test-')));
  mediaRoot = path.join(tempDir, 'media');
  moviesRoot = path.join(mediaRoot, 'movies');
  tvRoot = path.join(mediaRoot, 'tv');
  animeRoot = path.join(mediaRoot, 'anime');

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();

  // Master fixtures: one real tiny video and one audio-only mkv, copied to
  // every fixture path (one ffmpeg run each keeps the suite fast).
  videoMaster = path.join(tempDir, 'master.mkv');
  audioMaster = path.join(tempDir, 'audio-only.mkv');
  // prettier-ignore
  await execFileAsync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2',
    '-metadata:s:a:0', 'language=eng',
    '-shortest',
    videoMaster,
  ]);
  // prettier-ignore
  await execFileAsync(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'aac',
    audioMaster,
  ]);

  // --- Movies fixture tree ---
  const testMovieDir = path.join(moviesRoot, 'Test Movie (2020)');
  const matrixDir = path.join(moviesRoot, 'The Matrix (1999)');
  await mkdir(testMovieDir, { recursive: true });
  await mkdir(matrixDir, { recursive: true });
  await mkdir(path.join(moviesRoot, '.secrets'), { recursive: true });

  movie1080 = path.join(testMovieDir, 'Test.Movie.2020.1080p.mkv');
  movie2160 = path.join(testMovieDir, 'Test.Movie.2020.2160p.mkv');
  matrixFile = path.join(matrixDir, 'The.Matrix.1999.mkv');
  await copyFile(videoMaster, movie1080);
  await copyFile(videoMaster, movie2160);
  await copyFile(videoMaster, matrixFile);
  // Junk that must be seen but skipped:
  await copyFile(videoMaster, path.join(testMovieDir, 'Test Movie (2020)-trailer.mkv'));
  await copyFile(videoMaster, path.join(moviesRoot, 'sample.mkv'));
  await writeFile(path.join(moviesRoot, 'empty.mkv'), '');
  await writeFile(path.join(moviesRoot, 'NotAVideo.2021.mkv'), 'plain text, not matroska\n');
  await copyFile(audioMaster, path.join(moviesRoot, 'Audio.Only.2022.mkv'));
  // Never seen at all: dotfiles, files in dot-dirs, symlinks.
  await copyFile(videoMaster, path.join(moviesRoot, '.hidden.mkv'));
  await copyFile(videoMaster, path.join(moviesRoot, '.secrets', 'inside.mkv'));
  await symlink(videoMaster, path.join(moviesRoot, 'escape.mkv'));

  // --- TV fixture tree ---
  const seasonDir = path.join(tvRoot, 'Show', 'Season 1');
  await mkdir(seasonDir, { recursive: true });
  await copyFile(videoMaster, path.join(seasonDir, 'Show - S01E01 - Pilot.mkv'));
  await copyFile(videoMaster, path.join(seasonDir, 'Show - S01E02.mkv'));
  await copyFile(videoMaster, path.join(tvRoot, 'randomfile.mkv')); // unparseable

  // --- Anime fixture tree ---
  await mkdir(animeRoot, { recursive: true });
  await copyFile(videoMaster, path.join(animeRoot, '[Grp] Anime - 01 [1080p].mkv'));

  moviesLibraryId = await createLibrary('Movies', 'movies', [moviesRoot]);
  tvLibraryId = await createLibrary('TV', 'tv', [tvRoot]);
  animeLibraryId = await createLibrary('Anime', 'anime', [animeRoot]);
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('toSortTitle', () => {
  it('moves leading articles to the end', () => {
    expect(toSortTitle('The Matrix')).toBe('Matrix, The');
    expect(toSortTitle('A Quiet Place')).toBe('Quiet Place, A');
    expect(toSortTitle('An American Tail')).toBe('American Tail, An');
    expect(toSortTitle('Inception')).toBe('Inception');
    expect(toSortTitle('Them')).toBe('Them'); // "The" must be a whole word
  });
});

describe('movies library', () => {
  it('creates movie items, files and streams on first scan', async () => {
    const snapshots: ScanStats[] = [];
    const stats = await scanLibrary(moviesLibraryId, {
      mediaRoots: [mediaRoot],
      onProgress: (progress) => snapshots.push(progress),
    });

    expect(stats).toMatchObject({
      filesSeen: 8, // 3 movies + trailer + sample + empty + text + audio-only
      filesAdded: 3,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesMissing: 0,
      filesSkipped: 5, // trailer, sample, zero-byte, text (probe error), audio-only
      itemsCreated: 2,
    });
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]?.path).toContain('NotAVideo.2021.mkv');

    // Live progress: snapshots were emitted and converge on the final stats.
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toEqual(stats);

    const items = await prisma.mediaItem.findMany({
      where: { libraryId: moviesLibraryId },
      include: { files: { include: { streams: true }, orderBy: { path: 'asc' } } },
      orderBy: { title: 'asc' },
    });
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.type)).toEqual(['movie', 'movie']);

    const testMovie = items.find((item) => item.title === 'Test Movie');
    expect(testMovie).toMatchObject({ year: 2020, sortTitle: 'Test Movie', parentId: null });
    // Multi-version: both files share the one movie item.
    expect(testMovie?.files.map((file) => path.basename(file.path))).toEqual([
      'Test.Movie.2020.1080p.mkv',
      'Test.Movie.2020.2160p.mkv',
    ]);

    const matrix = items.find((item) => item.title === 'The Matrix');
    expect(matrix).toMatchObject({ year: 1999, sortTitle: 'Matrix, The' });
    expect(matrix?.files).toHaveLength(1);

    // MediaFile fields + persisted probe data + streams.
    const masterSize = (await stat(videoMaster)).size;
    const file = testMovie?.files[0];
    expect(file).toMatchObject({
      path: movie1080,
      size: BigInt(masterSize),
      status: 'available',
      videoCodec: 'h264',
      width: 320,
      height: 240,
    });
    expect(file?.container).toContain('matroska');
    expect(file?.mtimeMs).toBeGreaterThan(0n);
    expect(file?.durationMs).toBeGreaterThan(500);
    expect(file?.streams.map((stream) => stream.type).sort()).toEqual(['audio', 'video']);

    // Junk and hidden files never became rows.
    const allPaths = items.flatMap((item) => item.files.map((entry) => entry.path));
    for (const banned of ['sample', 'trailer', 'empty', 'NotAVideo', 'Audio.Only', '.hidden']) {
      expect(allPaths.some((entry) => entry.includes(banned)), banned).toBe(false);
    }
  });

  it('rescan leaves unchanged files alone and does not re-probe them', async () => {
    const { probe, paths } = countingProbe();
    const stats = await scan(moviesLibraryId, probe);

    expect(stats).toMatchObject({
      filesSeen: 8,
      filesAdded: 0,
      filesUpdated: 0,
      filesUnchanged: 3,
      filesSkipped: 5,
      itemsCreated: 0,
    });
    expect(stats.errors).toHaveLength(1);

    // Only the rowless junk (broken text file, audio-only file) is probed
    // again; the three stored videos are matched by path+size+mtime.
    expect(paths.sort()).toEqual([
      path.join(moviesRoot, 'Audio.Only.2022.mkv'),
      path.join(moviesRoot, 'NotAVideo.2021.mkv'),
    ]);

    // No duplicate rows.
    expect(await prisma.mediaItem.count({ where: { libraryId: moviesLibraryId } })).toBe(2);
    expect(
      await prisma.mediaFile.count({ where: { mediaItem: { libraryId: moviesLibraryId } } }),
    ).toBe(3);
  });

  it('re-probes and updates a file whose size/mtime changed', async () => {
    await appendFile(matrixFile, 'extra bytes to change size and mtime');
    const newSize = (await stat(matrixFile)).size;

    const { probe, paths } = countingProbe();
    const stats = await scan(moviesLibraryId, probe);

    expect(stats).toMatchObject({ filesUpdated: 1, filesUnchanged: 2, filesAdded: 0 });
    expect(paths).toContain(matrixFile);
    expect(paths).not.toContain(movie1080);

    const row = await prisma.mediaFile.findUniqueOrThrow({ where: { path: matrixFile } });
    expect(row.size).toBe(BigInt(newSize));
    expect(row.status).toBe('available');
    expect(row.videoCodec).toBe('h264'); // re-probed successfully
    expect(
      await prisma.mediaFile.count({ where: { mediaItem: { libraryId: moviesLibraryId } } }),
    ).toBe(3);
  });

  it('deletes the stale row when a video file is replaced by a non-video', async () => {
    await copyFile(audioMaster, movie2160);

    const stats = await scan(moviesLibraryId);
    expect(stats).toMatchObject({
      filesAdded: 0,
      filesUpdated: 0,
      filesUnchanged: 2,
      filesSkipped: 6, // the usual 5 + the replaced file (no video stream)
      filesMissing: 0,
    });
    expect(await prisma.mediaFile.findUnique({ where: { path: movie2160 } })).toBeNull();

    // Restoring real video content re-adds the file to the existing item.
    await copyFile(videoMaster, movie2160);
    const restored = await scan(moviesLibraryId);
    expect(restored).toMatchObject({ filesAdded: 1, itemsCreated: 0 });
    const movie = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: moviesLibraryId, title: 'Test Movie' },
      include: { files: true },
    });
    expect(movie.files).toHaveLength(2);
  });

  it('marks deleted files missing, then available again once restored', async () => {
    const content = await readFile(matrixFile);
    const row = await prisma.mediaFile.findUniqueOrThrow({ where: { path: matrixFile } });
    await rm(matrixFile);

    const stats = await scan(moviesLibraryId);
    expect(stats).toMatchObject({ filesSeen: 7, filesMissing: 1, filesUnchanged: 2 });
    const missing = await prisma.mediaFile.findUniqueOrThrow({ where: { path: matrixFile } });
    expect(missing.status).toBe('missing');
    // The owning item is left alone.
    expect(
      await prisma.mediaItem.findFirst({ where: { libraryId: moviesLibraryId, title: 'The Matrix' } }),
    ).not.toBeNull();

    // A second scan does not count the still-missing file again.
    const again = await scan(moviesLibraryId);
    expect(again.filesMissing).toBe(0);
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { path: matrixFile } })).status).toBe(
      'missing',
    );

    // Restore with identical content and mtime: the unchanged path revives it.
    await writeFile(matrixFile, content);
    const mtime = new Date(Number(row.mtimeMs));
    await utimes(matrixFile, mtime, mtime);
    const { probe, paths } = countingProbe();
    const revived = await scan(moviesLibraryId, probe);
    expect(revived).toMatchObject({ filesUnchanged: 3, filesAdded: 0, filesUpdated: 0 });
    expect(paths).not.toContain(matrixFile);
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { path: matrixFile } })).status).toBe(
      'available',
    );
  });
});

describe('tv library', () => {
  it('creates the show -> season -> episode hierarchy', async () => {
    const stats = await scan(tvLibraryId);

    expect(stats).toMatchObject({
      filesSeen: 3,
      filesAdded: 2,
      filesSkipped: 1, // unparseable name
      itemsCreated: 4, // show + season + 2 episodes
    });
    expect(stats.errors).toEqual([]);

    const show = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: tvLibraryId, type: 'show' },
    });
    expect(show).toMatchObject({ title: 'Show', sortTitle: 'Show', parentId: null });

    const season = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: tvLibraryId, type: 'season' },
    });
    expect(season).toMatchObject({ title: 'Season 1', seasonNumber: 1, parentId: show.id });

    const episodes = await prisma.mediaItem.findMany({
      where: { libraryId: tvLibraryId, type: 'episode' },
      include: { files: true },
      orderBy: { episodeNumber: 'asc' },
    });
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({
      title: 'Pilot',
      parentId: season.id,
      seasonNumber: 1,
      episodeNumber: 1,
      absoluteEpisodeNumber: null,
    });
    expect(episodes[1]).toMatchObject({
      title: 'Episode 2', // no episode title in the filename -> fallback
      parentId: season.id,
      seasonNumber: 1,
      episodeNumber: 2,
      absoluteEpisodeNumber: null,
    });
    expect(episodes[0]?.files).toHaveLength(1);

    // The unparseable file produced no rows at all.
    expect(await prisma.mediaItem.count({ where: { libraryId: tvLibraryId } })).toBe(4);
  });

  it('rescan probes nothing and creates nothing', async () => {
    const { probe, paths } = countingProbe();
    const stats = await scan(tvLibraryId, probe);

    expect(stats).toMatchObject({
      filesSeen: 3,
      filesUnchanged: 2,
      filesSkipped: 1, // unparseable names are skipped before probing
      filesAdded: 0,
      itemsCreated: 0,
    });
    expect(paths).toEqual([]);
    expect(await prisma.mediaItem.count({ where: { libraryId: tvLibraryId } })).toBe(4);
  });
});

describe('anime library', () => {
  it('attaches absolute-numbered files to season 1 with absoluteEpisodeNumber', async () => {
    const stats = await scan(animeLibraryId);
    expect(stats).toMatchObject({ filesSeen: 1, filesAdded: 1, itemsCreated: 3 });

    const show = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: animeLibraryId, type: 'show' },
    });
    expect(show.title).toBe('Anime');

    const season = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: animeLibraryId, type: 'season' },
    });
    expect(season).toMatchObject({ seasonNumber: 1, parentId: show.id });

    const episode = await prisma.mediaItem.findFirstOrThrow({
      where: { libraryId: animeLibraryId, type: 'episode' },
    });
    expect(episode).toMatchObject({
      parentId: season.id,
      seasonNumber: 1,
      episodeNumber: 1,
      absoluteEpisodeNumber: 1,
    });
  });
});

describe('roots and failure modes', () => {
  it('skips invalid roots with a warning but scans the valid ones', async () => {
    const okRoot = path.join(mediaRoot, 'ok-movies');
    await mkdir(okRoot, { recursive: true });
    await copyFile(videoMaster, path.join(okRoot, 'Solo Film (2021).mkv'));
    const ghostRoot = path.join(mediaRoot, 'ghost'); // never created on disk

    const libraryId = await createLibrary('Partial', 'movies', [okRoot, ghostRoot]);
    const stats = await scan(libraryId);

    expect(stats).toMatchObject({ filesSeen: 1, filesAdded: 1, itemsCreated: 1 });
    expect(stats.errors).toEqual([]);
  });

  it('rejects an unknown library id', async () => {
    await expect(scan('no-such-library')).rejects.toThrow(/not found/);
  });
});

describe('trickplay pre-warm hook', () => {
  it('invokes the hook once per newly added file, with the probed dimensions', async () => {
    const root = path.join(mediaRoot, 'prewarm-hit');
    await mkdir(root, { recursive: true });
    const filePath = path.join(root, 'Prewarm Movie (2021).mkv');
    await copyFile(videoMaster, filePath);
    const libraryId = await createLibrary('Prewarm Movies', 'movies', [root]);

    const calls: TrickplayScanFile[] = [];
    const trickplay: TrickplayScanHook = async (file) => {
      calls.push(file);
    };
    const stats = await scanLibrary(libraryId, { mediaRoots: [mediaRoot], trickplay });

    expect(stats.filesAdded).toBe(1);
    expect(calls).toHaveLength(1);
    // Dimensions come from the master fixture (320x240); the id is a real row.
    expect(calls[0]).toMatchObject({ path: filePath, width: 320, height: 240 });
    const file = await prisma.mediaFile.findUnique({ where: { id: calls[0]!.id } });
    expect(file).not.toBeNull();

    // A re-scan with the file unchanged adds nothing, so the hook is not called.
    calls.length = 0;
    const rescan = await scanLibrary(libraryId, { mediaRoots: [mediaRoot], trickplay });
    expect(rescan.filesUnchanged).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('never lets a hook failure fail the scan', async () => {
    const root = path.join(mediaRoot, 'prewarm-fail');
    await mkdir(root, { recursive: true });
    await copyFile(videoMaster, path.join(root, 'Boom (2020).mkv'));
    const libraryId = await createLibrary('Prewarm Fail', 'movies', [root]);

    const trickplay: TrickplayScanHook = async () => {
      throw new Error('boom');
    };
    const stats = await scanLibrary(libraryId, { mediaRoots: [mediaRoot], trickplay });

    expect(stats.filesAdded).toBe(1);
    expect(stats.errors).toEqual([]);
  });
});
