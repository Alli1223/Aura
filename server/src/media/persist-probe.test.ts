import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import type { ProbeResult } from './ffprobe.js';
import { persistProbe } from './persist-probe.js';

// Round-trips ProbeResults into a real temporary SQLite database created by
// applying the committed migrations (same approach as src/db/db.test.ts).

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-persist-probe-test-'));
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

async function createMediaFile(): Promise<string> {
  const suffix = randomUUID();
  const library = await prisma.library.create({
    data: {
      name: `Library ${suffix}`,
      type: 'movies',
      paths: { create: { path: `/media/movies/${suffix}` } },
    },
  });
  const movie = await prisma.mediaItem.create({
    data: { libraryId: library.id, type: 'movie', title: 'Movie', sortTitle: 'movie' },
  });
  const file = await prisma.mediaFile.create({
    data: {
      mediaItemId: movie.id,
      path: `/media/movies/${suffix}/movie.mkv`,
      size: 5_000_000n,
      mtimeMs: 1_700_000_000_000n,
    },
  });
  return file.id;
}

/** A typical movie probe: cover art + h264 video + two audio + forced sub. */
function movieProbe(): ProbeResult {
  return {
    container: 'matroska,webm',
    durationMs: 5_400_000,
    bitrate: 8_000_000,
    sizeBytes: 5_000_000,
    streams: [
      {
        index: 0,
        type: 'video',
        codec: 'mjpeg',
        width: 600,
        height: 900,
        isAttachedPic: true,
        language: undefined,
        title: 'cover',
        isDefault: false,
        isForced: false,
      },
      {
        index: 1,
        type: 'video',
        codec: 'h264',
        width: 1920,
        height: 1080,
        isAttachedPic: false,
        language: undefined,
        title: undefined,
        isDefault: true,
        isForced: false,
      },
      {
        index: 2,
        type: 'audio',
        codec: 'aac',
        channels: 6,
        channelLayout: '5.1',
        language: 'eng',
        title: 'English 5.1',
        isDefault: true,
        isForced: false,
      },
      {
        index: 3,
        type: 'audio',
        codec: 'ac3',
        channels: 2,
        channelLayout: 'stereo',
        language: 'jpn',
        title: undefined,
        isDefault: false,
        isForced: false,
      },
      {
        index: 4,
        type: 'subtitle',
        codec: 'subrip',
        language: 'eng',
        title: 'Signs & Songs',
        isDefault: false,
        isForced: true,
      },
    ],
  };
}

describe('persistProbe', () => {
  it('updates the MediaFile from the first real video stream and writes all streams', async () => {
    const mediaFileId = await createMediaFile();

    await persistProbe(mediaFileId, movieProbe());

    const file = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: mediaFileId },
      include: { streams: { orderBy: { streamIndex: 'asc' } } },
    });

    // Video fields come from the h264 stream, not the attached-pic cover art.
    expect(file).toMatchObject({
      container: 'matroska,webm',
      durationMs: 5_400_000,
      bitrate: 8_000_000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
    });
    // Scanner-owned fields are untouched.
    expect(file.size).toBe(5_000_000n);
    expect(file.status).toBe('available');

    expect(file.streams).toHaveLength(5);
    expect(file.streams).toEqual([
      expect.objectContaining({
        streamIndex: 0,
        type: 'video',
        codec: 'mjpeg',
        language: null,
        title: 'cover',
        channels: null,
        isDefault: false,
        isForced: false,
      }),
      expect.objectContaining({
        streamIndex: 1,
        type: 'video',
        codec: 'h264',
        language: null,
        title: null,
        channels: null,
        isDefault: true,
        isForced: false,
      }),
      expect.objectContaining({
        streamIndex: 2,
        type: 'audio',
        codec: 'aac',
        language: 'eng',
        title: 'English 5.1',
        channels: 6,
        isDefault: true,
        isForced: false,
      }),
      expect.objectContaining({
        streamIndex: 3,
        type: 'audio',
        codec: 'ac3',
        language: 'jpn',
        title: null,
        channels: 2,
        isDefault: false,
        isForced: false,
      }),
      expect.objectContaining({
        streamIndex: 4,
        type: 'subtitle',
        codec: 'subrip',
        language: 'eng',
        title: 'Signs & Songs',
        channels: null,
        isDefault: false,
        isForced: true,
      }),
    ]);
  });

  it('is idempotent: re-persisting the same probe leaves no duplicate rows', async () => {
    const mediaFileId = await createMediaFile();

    await persistProbe(mediaFileId, movieProbe());
    await persistProbe(mediaFileId, movieProbe());

    const streams = await prisma.mediaStream.findMany({ where: { mediaFileId } });
    expect(streams).toHaveLength(5);
    expect(new Set(streams.map((s) => s.streamIndex)).size).toBe(5);
  });

  it('replaces streams wholesale when a re-probe reports different streams', async () => {
    const mediaFileId = await createMediaFile();
    await persistProbe(mediaFileId, movieProbe());

    const remuxed: ProbeResult = {
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationMs: 5_400_100,
      bitrate: 4_000_000,
      sizeBytes: 2_700_000,
      streams: [
        {
          index: 0,
          type: 'video',
          codec: 'hevc',
          width: 1280,
          height: 720,
          isAttachedPic: false,
          language: undefined,
          title: undefined,
          isDefault: true,
          isForced: false,
        },
        {
          index: 1,
          type: 'audio',
          codec: 'aac',
          channels: 2,
          channelLayout: 'stereo',
          language: 'eng',
          title: undefined,
          isDefault: true,
          isForced: false,
        },
      ],
    };
    await persistProbe(mediaFileId, remuxed);

    const file = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: mediaFileId },
      include: { streams: { orderBy: { streamIndex: 'asc' } } },
    });
    expect(file).toMatchObject({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationMs: 5_400_100,
      bitrate: 4_000_000,
      width: 1280,
      height: 720,
      videoCodec: 'hevc',
    });
    expect(file.streams).toHaveLength(2);
    expect(file.streams.map((s) => s.codec)).toEqual(['hevc', 'aac']);
  });

  it('nulls video fields when the probe has no real video stream', async () => {
    const mediaFileId = await createMediaFile();
    await persistProbe(mediaFileId, movieProbe());

    const audioOnly: ProbeResult = {
      container: 'mp3',
      durationMs: 180_000,
      bitrate: 128_000,
      sizeBytes: 2_880_000,
      streams: [
        {
          index: 0,
          type: 'audio',
          codec: 'mp3',
          channels: 2,
          channelLayout: 'stereo',
          language: undefined,
          title: undefined,
          isDefault: false,
          isForced: false,
        },
      ],
    };
    await persistProbe(mediaFileId, audioOnly);

    const file = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    expect(file.width).toBeNull();
    expect(file.height).toBeNull();
    expect(file.videoCodec).toBeNull();
  });

  it('rejects for an unknown mediaFileId without writing stream rows', async () => {
    const before = await prisma.mediaStream.count();

    await expect(persistProbe('does-not-exist', movieProbe())).rejects.toSatisfy(
      (err) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025',
    );

    expect(await prisma.mediaStream.count()).toBe(before);
  });
});
