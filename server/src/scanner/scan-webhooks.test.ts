import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import type { ProbeFn } from './scan.js';
import { scanLibrary } from './scan.js';
import { MEDIA_ADDED_EMISSION_CAP, type DispatchFn } from '../lib/webhooks.js';

// media.added emission from the scanner. Uses a FAKE probe (no ffmpeg) and a
// spy dispatcher, so it asserts emission without any network and without the
// heavy ffmpeg fixtures the end-to-end scan test uses.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let mediaRoot: string;
let prisma: PrismaClient;

/** A fake probe that reports a single real video stream for any input. */
const fakeProbe: ProbeFn = async () => ({
  container: 'matroska,webm',
  durationMs: 1000,
  bitrate: 1_000_000,
  sizeBytes: 1024,
  streams: [
    {
      type: 'video',
      index: 0,
      codec: 'h264',
      language: undefined,
      title: undefined,
      isDefault: true,
      isForced: false,
      width: 320,
      height: 240,
      isAttachedPic: false,
    },
  ],
});

function spyDispatch(): ReturnType<typeof vi.fn<DispatchFn>> {
  return vi.fn<DispatchFn>().mockResolvedValue([]);
}

/**
 * A fresh, isolated movies library rooted at its own subdirectory, so scans in
 * different tests never see each other's files. Returns a helper to write a
 * movie file into this library's root plus the created library id.
 */
async function freshLibrary(): Promise<{
  libraryId: string;
  writeMovie: (relDir: string, fileName: string) => Promise<void>;
}> {
  const slug = Math.random().toString(36).slice(2, 10);
  const root = path.join(mediaRoot, slug);
  await mkdir(root, { recursive: true });
  const library = await prisma.library.create({
    data: {
      name: `movies-${slug}`,
      type: 'movies',
      paths: { create: [{ path: root }] },
    },
  });
  const writeMovie = async (relDir: string, fileName: string): Promise<void> => {
    const dir = path.join(root, relDir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), 'x');
  };
  return { libraryId: library.id, writeMovie };
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), 'aura-scan-webhook-')));
  mediaRoot = path.join(tempDir, 'media');
  await mkdir(mediaRoot, { recursive: true });

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('scanner media.added emission', () => {
  it('emits media.added once per newly-created top-level item', async () => {
    const { libraryId, writeMovie } = await freshLibrary();
    await writeMovie('Inception (2010)', 'Inception (2010).mkv');
    const dispatch = spyDispatch();

    const stats = await scanLibrary(libraryId, {
      mediaRoots: [mediaRoot],
      probe: fakeProbe,
      dispatch,
    });
    expect(stats.itemsCreated).toBe(1);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [eventType, data] = dispatch.mock.calls[0]!;
    expect(eventType).toBe('media.added');
    const item = await prisma.mediaItem.findFirstOrThrow({ where: { libraryId, type: 'movie' } });
    expect(data).toEqual({
      itemId: item.id,
      libraryId,
      type: 'movie',
      title: 'Inception',
    });
  });

  it('emits nothing on a re-scan that finds no new items', async () => {
    const { libraryId, writeMovie } = await freshLibrary();
    await writeMovie('Arrival (2016)', 'Arrival (2016).mkv');

    const first = spyDispatch();
    await scanLibrary(libraryId, { mediaRoots: [mediaRoot], probe: fakeProbe, dispatch: first });
    expect(first).toHaveBeenCalledTimes(1);

    const second = spyDispatch();
    const stats = await scanLibrary(libraryId, {
      mediaRoots: [mediaRoot],
      probe: fakeProbe,
      dispatch: second,
    });
    expect(stats.itemsCreated).toBe(0);
    expect(second).not.toHaveBeenCalled();
  });

  it('skips emission entirely when a scan exceeds the flood cap', async () => {
    const { libraryId, writeMovie } = await freshLibrary();
    const count = MEDIA_ADDED_EMISSION_CAP + 1;
    for (let i = 0; i < count; i += 1) {
      await writeMovie(`Flood Movie ${i} (2000)`, `Flood Movie ${i} (2000).mkv`);
    }
    const dispatch = spyDispatch();

    const stats = await scanLibrary(libraryId, {
      mediaRoots: [mediaRoot],
      probe: fakeProbe,
      dispatch,
    });
    expect(stats.itemsCreated).toBe(count);
    // Over the cap => the whole run's media.added emissions are suppressed.
    expect(dispatch).not.toHaveBeenCalled();
  });
});
