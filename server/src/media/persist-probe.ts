import { getPrisma } from '../db/client.js';
import { realVideoStreams, type ProbeResult } from './ffprobe.js';

/**
 * Persists a ProbeResult onto an existing MediaFile row: updates the file's
 * container/duration/bitrate/dimensions/videoCodec (video fields come from
 * the first real — non cover art — video stream) and replaces all of its
 * MediaStream and Chapter rows in a single transaction, so re-probing the same
 * file is idempotent and never leaves duplicate or stale rows behind.
 *
 * Throws Prisma's P2025 error if `mediaFileId` does not exist.
 */
export async function persistProbe(mediaFileId: string, probe: ProbeResult): Promise<void> {
  const prisma = getPrisma();
  const video = realVideoStreams(probe)[0];

  const streamRows = probe.streams.map((stream) => ({
    mediaFileId,
    streamIndex: stream.index,
    type: stream.type,
    codec: stream.codec ?? null,
    language: stream.language ?? null,
    title: stream.title ?? null,
    channels: stream.type === 'audio' ? (stream.channels ?? null) : null,
    isDefault: stream.isDefault,
    isForced: stream.isForced,
  }));

  const chapterRows = probe.chapters.map((chapter) => ({
    mediaFileId,
    index: chapter.index,
    startMs: chapter.startMs,
    endMs: chapter.endMs,
    title: chapter.title ?? null,
  }));

  await prisma.$transaction([
    prisma.mediaFile.update({
      where: { id: mediaFileId },
      data: {
        container: probe.container,
        durationMs: probe.durationMs ?? null,
        bitrate: probe.bitrate ?? null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        videoCodec: video?.codec ?? null,
      },
    }),
    prisma.mediaStream.deleteMany({ where: { mediaFileId } }),
    prisma.mediaStream.createMany({ data: streamRows }),
    prisma.chapter.deleteMany({ where: { mediaFileId } }),
    prisma.chapter.createMany({ data: chapterRows }),
  ]);
}
