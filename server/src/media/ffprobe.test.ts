import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isVideoFile,
  probeFile,
  ProbeError,
  type ProbeAudioStream,
  type ProbeResult,
  type ProbeSubtitleStream,
  type ProbeVideoStream,
} from './ffprobe.js';

// These tests exercise the real ffprobe binary against tiny fixture files
// generated once (in beforeAll) with the real ffmpeg binary. ffmpeg/ffprobe
// are hard requirements of this project (they ship in the Docker image and
// are installed in CI); if they are missing the suite fails loudly rather
// than silently skipping. Binary locations are configurable via the
// FFMPEG_PATH and FFPROBE_PATH environment variables (defaults: "ffmpeg" and
// "ffprobe" resolved from PATH).

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

let fixtureDir: string;
let tinyMp4: string;
let multiMkv: string;
let corruptMkv: string;
let audioMp3: string;

async function assertToolAvailable(binary: string, envVar: string): Promise<void> {
  try {
    await execFileAsync(binary, ['-version']);
  } catch (cause) {
    throw new Error(
      `"${binary}" is not runnable. ffmpeg/ffprobe are required to run the media test suite ` +
        `(and to run Aura itself) — install ffmpeg or point ${envVar} at the binary.`,
      { cause },
    );
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, ['-y', '-v', 'error', ...args]);
}

beforeAll(async () => {
  await assertToolAvailable(FFMPEG, 'FFMPEG_PATH');
  await assertToolAvailable(process.env.FFPROBE_PATH ?? 'ffprobe', 'FFPROBE_PATH');

  fixtureDir = await mkdtemp(path.join(tmpdir(), 'aura-ffprobe-test-'));
  tinyMp4 = path.join(fixtureDir, 'tiny.mp4');
  multiMkv = path.join(fixtureDir, 'multi.mkv');
  corruptMkv = path.join(fixtureDir, 'corrupt.mkv');
  audioMp3 = path.join(fixtureDir, 'audio.mp3');
  const srtPath = path.join(fixtureDir, 'subs.srt');

  // (1) Tiny mp4: 2s 320x240 h264 test pattern + stereo aac audio tagged eng.
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2',
    '-metadata:s:a:0', 'language=eng',
    '-shortest',
    tinyMp4,
  ]);

  // (2) mkv: h264 video + two audio tracks (eng default, jpn) + forced eng
  // srt subtitle track.
  await writeFile(
    srtPath,
    '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n',
    'utf8',
  );
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-i', srtPath,
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:s:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2',
    '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English',
    '-metadata:s:a:1', 'language=jpn', '-metadata:s:a:1', 'title=Japanese',
    '-metadata:s:s:0', 'language=eng',
    '-disposition:a:0', 'default',
    '-disposition:a:1', '0',
    '-disposition:s:0', 'forced',
    multiMkv,
  ]);

  // (3) A text file wearing an .mkv extension — not a media file.
  await writeFile(corruptMkv, 'this is definitely not a matroska file\n', 'utf8');

  // (4) Audio-only mp3.
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'libmp3lame',
    audioMp3,
  ]);
}, 120_000);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function expectProbeError(promise: Promise<unknown>): Promise<ProbeError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ProbeError);
    return err as ProbeError;
  }
  throw new Error('expected probeFile to reject with a ProbeError, but it resolved');
}

describe('probeFile', () => {
  it('probes the tiny mp4 fixture fully', async () => {
    const probe = await probeFile(tinyMp4);

    expect(probe.container).toContain('mp4');
    expect(probe.durationMs).toBeGreaterThan(1800);
    expect(probe.durationMs).toBeLessThan(2500);
    expect(probe.bitrate).toBeGreaterThan(0);
    expect(probe.sizeBytes).toBeGreaterThan(0);
    expect(probe.streams).toHaveLength(2);

    const video = probe.streams[0] as ProbeVideoStream;
    expect(video).toMatchObject({
      index: 0,
      type: 'video',
      codec: 'h264',
      width: 320,
      height: 240,
      isAttachedPic: false,
      isForced: false,
    });
    // The mov muxer tags untagged streams "und", which normalises away.
    expect(video.language).toBeUndefined();

    const audio = probe.streams[1] as ProbeAudioStream;
    expect(audio).toMatchObject({
      index: 1,
      type: 'audio',
      codec: 'aac',
      channels: 2,
      channelLayout: 'stereo',
      language: 'eng',
      isDefault: true,
      isForced: false,
    });
  });

  it('probes the multi-track mkv fixture fully', async () => {
    const probe = await probeFile(multiMkv);

    expect(probe.container).toBe('matroska,webm');
    expect(probe.durationMs).toBeGreaterThan(1800);
    expect(probe.durationMs).toBeLessThan(2500);
    expect(probe.bitrate).toBeGreaterThan(0);
    expect(probe.streams).toHaveLength(4);
    expect(probe.streams.map((s) => s.type)).toEqual(['video', 'audio', 'audio', 'subtitle']);

    const [video, audioEng, audioJpn, subtitle] = probe.streams as [
      ProbeVideoStream,
      ProbeAudioStream,
      ProbeAudioStream,
      ProbeSubtitleStream,
    ];

    expect(video).toMatchObject({ index: 0, codec: 'h264', width: 320, height: 240 });
    expect(video.language).toBeUndefined();

    expect(audioEng).toMatchObject({
      index: 1,
      codec: 'aac',
      channels: 2,
      language: 'eng',
      title: 'English',
      isDefault: true,
      isForced: false,
    });
    expect(audioJpn).toMatchObject({
      index: 2,
      codec: 'aac',
      channels: 2,
      language: 'jpn',
      title: 'Japanese',
      isDefault: false,
      isForced: false,
    });
    expect(subtitle).toMatchObject({
      index: 3,
      codec: 'subrip',
      language: 'eng',
      isDefault: false,
      isForced: true,
    });
  });

  it('probes the audio-only mp3 fixture', async () => {
    const probe = await probeFile(audioMp3);

    expect(probe.container).toBe('mp3');
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({ type: 'audio', codec: 'mp3' });
  });

  it('rejects a corrupt (non-media) file with a ffprobe-failed ProbeError', async () => {
    const err = await expectProbeError(probeFile(corruptMkv));

    expect(err.kind).toBe('ffprobe-failed');
    expect(err.filePath).toBe(corruptMkv);
    expect(err.exitCode).toBeGreaterThan(0);
    expect(err.stderr).toBeTruthy();
    expect(err.message).toContain('ffprobe exited');
  });

  it('rejects a missing file with a file-missing ProbeError', async () => {
    const missing = path.join(fixtureDir, 'does-not-exist.mkv');
    const err = await expectProbeError(probeFile(missing));

    expect(err.kind).toBe('file-missing');
    expect(err.filePath).toBe(missing);
    expect(err.message).toContain(missing);
  });

  it('rejects with ffprobe-not-found when the binary is missing', async () => {
    const err = await expectProbeError(
      probeFile(tinyMp4, { ffprobePath: '/nonexistent/ffprobe-nope' }),
    );

    expect(err.kind).toBe('ffprobe-not-found');
    expect(err.message).toContain('FFPROBE_PATH');
  });

  it('kills ffprobe and rejects with timeout when it exceeds the budget', async () => {
    // A FIFO with no writer blocks ffprobe's open() forever, making the
    // timeout path fully deterministic.
    const fifoPath = path.join(fixtureDir, 'stalled.fifo');
    await execFileAsync('mkfifo', [fifoPath]);

    const err = await expectProbeError(probeFile(fifoPath, { timeoutMs: 500 }));

    expect(err.kind).toBe('timeout');
    expect(err.message).toContain('500ms');
  }, 15_000);

  it('rejects with invalid-output when the binary emits non-JSON', async () => {
    // `echo` exits 0 and prints its arguments — valid process, garbage output.
    const err = await expectProbeError(probeFile(tinyMp4, { ffprobePath: 'echo' }));

    expect(err.kind).toBe('invalid-output');
  });
});

describe('isVideoFile', () => {
  it('is true for the mp4 and mkv fixtures', async () => {
    expect(isVideoFile(await probeFile(tinyMp4))).toBe(true);
    expect(isVideoFile(await probeFile(multiMkv))).toBe(true);
  });

  it('is false for the audio-only mp3 fixture', async () => {
    expect(isVideoFile(await probeFile(audioMp3))).toBe(false);
  });

  it('is false when the only video streams are embedded cover art', () => {
    const coverArtOnly: ProbeResult = {
      container: 'mp3',
      durationMs: 2000,
      bitrate: 128_000,
      sizeBytes: 32_000,
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
        {
          index: 1,
          type: 'video',
          codec: 'mjpeg',
          width: 600,
          height: 600,
          isAttachedPic: true,
          language: undefined,
          title: undefined,
          isDefault: false,
          isForced: false,
        },
      ],
    };

    expect(isVideoFile(coverArtOnly)).toBe(false);
  });
});
