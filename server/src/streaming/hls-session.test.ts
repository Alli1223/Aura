import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildHlsFfmpegArgs,
  clampStartOffset,
  HLS_PLAYLIST_NAME,
  HLS_QUALITY_NAMES,
  HlsInputError,
  HlsSessionManager,
  isHlsQualityName,
  QUALITIES,
  TooManySessionsError,
  type HlsSessionManagerOptions,
} from './hls-session.js';

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

// ---------------------------------------------------------------------------
// Pure arg-builder tests — NO ffmpeg spawned. These are the bulk of coverage
// and stay fast and deterministic.
// ---------------------------------------------------------------------------

describe('buildHlsFfmpegArgs', () => {
  const base = {
    inputPath: '/media/movies/film.mkv',
    outputDir: '/config/transcodes/sess-1',
  };

  /** Returns the value immediately following the first occurrence of `flag`. */
  function valueAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  }

  it('positions the input path immediately after -i and only there', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    const iIndex = args.indexOf('-i');
    expect(iIndex).toBeGreaterThanOrEqual(0);
    expect(args[iIndex + 1]).toBe('/media/movies/film.mkv');
    // The path appears exactly once (not smuggled into another arg).
    expect(args.filter((a) => a === base.inputPath)).toHaveLength(1);
  });

  it('is a flat array of separate string arguments (never one shell string)', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['1080p'] });
    expect(Array.isArray(args)).toBe(true);
    for (const arg of args) expect(typeof arg).toBe('string');
    // No single element bundles the whole command with spaces + a binary name.
    expect(args.some((a) => a.includes('ffmpeg '))).toBe(false);
  });

  it('contains no shell command-injection metacharacters in any argument', () => {
    // The filtergraph legitimately uses ( ) , : ' and the keyframe expr uses *
    // — none of which can chain or execute commands. What must NEVER appear are
    // the shell control operators, which spawn-with-arg-array also renders inert
    // but which we still assert are absent as defence in depth.
    const injection = /[;&|`$<>\n\r]/;
    for (const name of HLS_QUALITY_NAMES) {
      const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES[name] });
      for (const arg of args) {
        expect(injection.test(arg), `arg ${JSON.stringify(arg)}`).toBe(false);
      }
    }
  });

  it.each(HLS_QUALITY_NAMES)('maps %s to its scale cap and bitrate arguments', (name) => {
    const quality = QUALITIES[name];
    const args = buildHlsFfmpegArgs({ ...base, quality });

    // Never upscale: the scale filter caps width at min(iw, maxWidth) and lets
    // height follow (-2 = even, aspect-preserving).
    expect(valueAfter(args, '-vf')).toBe(`scale='min(iw,${quality.maxWidth})':-2`);
    expect(valueAfter(args, '-b:v')).toBe(quality.videoBitrate);
    expect(valueAfter(args, '-maxrate')).toBe(quality.maxrate);
    expect(valueAfter(args, '-bufsize')).toBe(quality.bufsize);
    expect(valueAfter(args, '-b:a')).toBe(quality.audioBitrate);
  });

  it('encodes video with software libx264 (veryfast) and stereo aac audio', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    expect(valueAfter(args, '-c:v')).toBe('libx264');
    expect(valueAfter(args, '-preset')).toBe('veryfast');
    expect(valueAfter(args, '-c:a')).toBe('aac');
    expect(valueAfter(args, '-ac')).toBe('2');
  });

  it('maps the first video, the selected audio (optional), and drops subtitles', () => {
    const def = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['480p'] });
    expect(def).toContain('-sn');
    // -map appears for video and audio.
    const maps = def.reduce<string[]>((acc, arg, i) => {
      if (arg === '-map') acc.push(def[i + 1] as string);
      return acc;
    }, []);
    expect(maps).toEqual(['0:v:0', '0:a:0?']);

    const withAudio = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['480p'],
      audioStreamIndex: 2,
    });
    const audioMap = withAudio[withAudio.lastIndexOf('-map') + 1];
    expect(audioMap).toBe('0:a:2?');
  });

  /** The audio-relative index mapped by `-map 0:a:<n>?` (the last -map value). */
  function audioMapOf(args: string[]): string | undefined {
    return args[args.lastIndexOf('-map') + 1];
  }

  it('maps the selected audio-relative index (0:a:1)', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['480p'], audioStreamIndex: 1 });
    expect(audioMapOf(args)).toBe('0:a:1?');
  });

  it('falls back to the first audio track for an omitted/invalid index', () => {
    expect(audioMapOf(buildHlsFfmpegArgs({ ...base, quality: QUALITIES['480p'] }))).toBe('0:a:0?');
    for (const bad of [-1, 1.5, Number.NaN]) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['480p'],
        audioStreamIndex: bad,
      });
      expect(audioMapOf(args), String(bad)).toBe('0:a:0?');
    }
  });

  it('downmixes to stereo (-ac 2) by default and when downmixStereo is true', () => {
    expect(valueAfter(buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] }), '-ac')).toBe('2');
    // Even a surround source is forced to stereo when the client is stereo-only.
    const forced = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      downmixStereo: true,
      sourceChannels: 6,
    });
    expect(valueAfter(forced, '-ac')).toBe('2');
  });

  it('preserves a surround source channel count when downmix is opted out', () => {
    const surround = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      downmixStereo: false,
      sourceChannels: 6,
    });
    expect(valueAfter(surround, '-ac')).toBe('6');
  });

  it('caps preserved surround channels at MAX_TRANSCODE_AUDIO_CHANNELS (6)', () => {
    const eight = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      downmixStereo: false,
      sourceChannels: 8,
    });
    expect(valueAfter(eight, '-ac')).toBe('6');
  });

  it('keeps the stereo baseline when opting out but the source is not surround', () => {
    for (const channels of [undefined, 1, 2]) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['720p'],
        downmixStereo: false,
        sourceChannels: channels,
      });
      expect(valueAfter(args, '-ac'), String(channels)).toBe('2');
    }
  });

  it('never injects shell metacharacters via audio selection or downmix', () => {
    const injection = /[;&|`$<>\n\r]/;
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['1080p'],
      audioStreamIndex: 3,
      downmixStereo: false,
      sourceChannels: 6,
    });
    for (const arg of args) expect(injection.test(arg), JSON.stringify(arg)).toBe(false);
  });

  it('emits an EVENT HLS playlist with independent, appendable mpegts segments', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    expect(valueAfter(args, '-f')).toBe('hls');
    expect(valueAfter(args, '-hls_time')).toBe('4');
    expect(valueAfter(args, '-hls_playlist_type')).toBe('event');
    expect(valueAfter(args, '-hls_flags')).toBe('independent_segments+append_list');
    expect(valueAfter(args, '-hls_segment_type')).toBe('mpegts');
    // Segment pattern and playlist both live under the session dir; the
    // playlist path is the final positional argument.
    expect(valueAfter(args, '-hls_segment_filename')).toBe(
      path.join(base.outputDir, 'segment%05d.ts'),
    );
    expect(args[args.length - 1]).toBe(path.join(base.outputDir, HLS_PLAYLIST_NAME));
  });

  it('accepts a hardware encoder override without touching the rest of the pipeline', () => {
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      videoEncoder: 'h264_vaapi',
    });
    expect(valueAfter(args, '-c:v')).toBe('h264_vaapi');
  });

  it('never produces an upscaling filter: min(iw,...) caps at the source width', () => {
    for (const name of HLS_QUALITY_NAMES) {
      const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES[name] });
      const vf = args[args.indexOf('-vf') + 1] as string;
      expect(vf.startsWith("scale='min(iw,")).toBe(true);
    }
  });

  // -- transcode-seek: -ss placement & formatting -------------------------

  it('places -ss with the offset immediately BEFORE -i when startOffsetSec > 0', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 12 });
    const ssIndex = args.indexOf('-ss');
    const iIndex = args.indexOf('-i');
    expect(ssIndex).toBeGreaterThanOrEqual(0);
    // -ss is a fast INPUT seek: it must sit directly before -i (input option).
    expect(args[ssIndex + 1]).toBe('12');
    expect(ssIndex).toBeLessThan(iIndex);
    expect(iIndex - ssIndex).toBe(2); // -ss <val> -i
    // The input path still follows -i untouched.
    expect(args[iIndex + 1]).toBe(base.inputPath);
  });

  it('formats a fractional offset as trimmed fixed-point (no scientific notation)', () => {
    expect(valueAfter(buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 5.5 }), '-ss')).toBe('5.5');
    // Whole numbers stay integer-formatted; sub-ms precision is trimmed.
    expect(valueAfter(buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 90 }), '-ss')).toBe('90');
    expect(valueAfter(buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 1.2345 }), '-ss')).toBe('1.234');
  });

  it('omits -ss entirely for offset 0, undefined, negative, or non-finite', () => {
    for (const offset of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: offset });
      expect(args.includes('-ss'), String(offset)).toBe(false);
      // -i is still the very first input option after the global flags.
      expect(args[args.indexOf('-i') + 1]).toBe(base.inputPath);
    }
  });

  it('never injects shell metacharacters via the seek offset', () => {
    const injection = /[;&|`$<>\n\r]/;
    for (const offset of [7, 5.5, 123.456, 3600]) {
      const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['1080p'], startOffsetSec: offset });
      for (const arg of args) expect(injection.test(arg), JSON.stringify(arg)).toBe(false);
    }
  });
});

describe('clampStartOffset', () => {
  it('returns 0 for an omitted, non-positive, or non-finite request', () => {
    for (const req of [undefined, 0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampStartOffset(req, 100), String(req)).toBe(0);
    }
  });

  it('passes a positive offset through when the duration is unknown', () => {
    expect(clampStartOffset(42, undefined)).toBe(42);
    expect(clampStartOffset(42, 0)).toBe(42);
    expect(clampStartOffset(42.5, Number.NaN)).toBe(42.5);
  });

  it('keeps an offset that falls within the known duration', () => {
    expect(clampStartOffset(30, 100)).toBe(30);
    expect(clampStartOffset(99.9, 100)).toBe(99.9);
  });

  it('caps an offset at or beyond the end to the duration', () => {
    expect(clampStartOffset(150, 100)).toBe(100);
    expect(clampStartOffset(100, 100)).toBe(100);
  });
});

describe('quality ladder', () => {
  it('exposes 1080p / 720p / 480p / 360p with descending width caps', () => {
    expect(HLS_QUALITY_NAMES).toEqual(['1080p', '720p', '480p', '360p']);
    expect(QUALITIES['1080p'].maxWidth).toBe(1920);
    expect(QUALITIES['720p'].maxWidth).toBe(1280);
    expect(QUALITIES['480p'].maxWidth).toBe(854);
    expect(QUALITIES['360p'].maxWidth).toBe(640);
  });

  it('narrows only known quality names', () => {
    expect(isHlsQualityName('720p')).toBe(true);
    expect(isHlsQualityName('4k')).toBe(false);
    expect(isHlsQualityName('constructor')).toBe(false);
    expect(isHlsQualityName('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spawn-based tests — REAL ffmpeg. Kept few and pointed at tiny clips so the
// suite stays fast. ffmpeg is a hard project dependency (Docker image + CI).
// ---------------------------------------------------------------------------

async function assertFfmpeg(): Promise<void> {
  try {
    await execFileAsync(FFMPEG, ['-version']);
  } catch (cause) {
    throw new Error(
      `"${FFMPEG}" is not runnable. ffmpeg is required for the HLS test suite — ` +
        'install ffmpeg or set FFMPEG_PATH.',
      { cause },
    );
  }
}

/** Reads a media playlist and returns the .ts segment names it lists. */
function segmentsInPlaylist(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts'));
}

describe('HlsSessionManager (real ffmpeg)', () => {
  let root: string;
  let mediaRoot: string;
  let transcodeDir: string;
  let outsideDir: string;
  let clipPath: string;
  const managers: HlsSessionManager[] = [];

  function makeManager(overrides: Partial<HlsSessionManagerOptions> = {}): HlsSessionManager {
    const manager = new HlsSessionManager({
      mediaRoots: [mediaRoot],
      getTranscodeDir: () => transcodeDir,
      ffmpegPath: FFMPEG,
      idleMs: 60_000,
      maxSessions: 3,
      readinessTimeoutMs: 30_000,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  }

  beforeAll(async () => {
    await assertFfmpeg();
    root = await mkdtemp(path.join(tmpdir(), 'aura-hls-mgr-'));
    mediaRoot = path.join(root, 'media');
    transcodeDir = path.join(root, 'transcodes');
    outsideDir = path.join(root, 'outside');
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(transcodeDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    clipPath = path.join(mediaRoot, 'clip.mp4');
    // 5s 640x480 h264 + stereo aac — small but long enough to yield >1 segment.
    // prettier-ignore
    await execFileAsync(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x480:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-shortest',
      clipPath,
    ]);
  }, 120_000);

  afterEach(async () => {
    await Promise.all(managers.map((m) => m.shutdown()));
    managers.length = 0;
    // No scratch dirs may survive a manager shutdown.
    const remaining = existsSync(transcodeDir) ? await readdir(transcodeDir) : [];
    expect(remaining).toEqual([]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const startClip = (
    manager: HlsSessionManager,
    over: Partial<{
      userId: string;
      quality: '1080p' | '720p' | '480p';
      id: string;
      startOffsetSec: number;
    }> = {},
  ) =>
    manager.startSession({
      mediaFile: { id: over.id ?? 'file-1', path: clipPath },
      quality: over.quality ?? '480p',
      userId: over.userId ?? 'user-1',
      startOffsetSec: over.startOffsetSec,
    });

  it('starts a session that resolves once a playlist and >=1 segment exist', async () => {
    const manager = makeManager();
    const session = await startClip(manager);

    expect(session.state).toBe('ready');
    expect(existsSync(session.outputDir)).toBe(true);
    const playlist = await readFile(path.join(session.outputDir, HLS_PLAYLIST_NAME), 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(segmentsInPlaylist(playlist).length).toBeGreaterThanOrEqual(1);
    expect(manager.getSession(session.id)).toBeDefined();
    expect(manager.activeCount).toBe(1);
  }, 60_000);

  it('transcodes the whole clip to completion (ENDLIST + every segment on disk)', async () => {
    const manager = makeManager();
    const session = await startClip(manager);

    const playlistPath = path.join(session.outputDir, HLS_PLAYLIST_NAME);
    const deadline = Date.now() + 45_000;
    let text = '';
    do {
      text = await readFile(playlistPath, 'utf8');
      if (text.includes('#EXT-X-ENDLIST')) break;
      await new Promise((r) => setTimeout(r, 150));
    } while (Date.now() < deadline);

    expect(text).toContain('#EXT-X-ENDLIST');
    const segments = segmentsInPlaylist(text);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const segment of segments) {
      expect(existsSync(path.join(session.outputDir, segment)), segment).toBe(true);
    }
  }, 60_000);

  it('reuses the live session for an identical (user,file,quality) request', async () => {
    const manager = makeManager();
    const first = await startClip(manager);
    const second = await startClip(manager);

    expect(second.id).toBe(first.id);
    expect(second.outputDir).toBe(first.outputDir);
    expect(manager.activeCount).toBe(1);
  }, 60_000);

  it('rejects the session beyond the concurrency cap with TooManySessionsError', async () => {
    const manager = makeManager({ maxSessions: 3 });
    await startClip(manager, { userId: 'u1' });
    await startClip(manager, { userId: 'u2' });
    await startClip(manager, { userId: 'u3' });
    expect(manager.activeCount).toBe(3);

    await expect(startClip(manager, { userId: 'u4' })).rejects.toBeInstanceOf(TooManySessionsError);
  }, 90_000);

  it('reaps an idle session: kills ffmpeg and removes the scratch dir', async () => {
    let clock = Date.now();
    const manager = makeManager({ idleMs: 50_000, now: () => clock });
    const session = await startClip(manager);
    const dir = session.outputDir;
    expect(existsSync(dir)).toBe(true);

    clock += 60_000; // advance the injected clock past the idle window
    await manager.reapIdleSessions();

    expect(manager.getSession(session.id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(manager.activeCount).toBe(0);
  }, 60_000);

  it('does not reap a session that was touched within the idle window', async () => {
    let clock = Date.now();
    const manager = makeManager({ idleMs: 50_000, now: () => clock });
    const session = await startClip(manager);

    clock += 40_000;
    manager.touch(session.id); // resets lastAccess to the current clock
    clock += 40_000; // 40s since the touch < 50s idle
    await manager.reapIdleSessions();

    expect(manager.getSession(session.id)).toBeDefined();
    expect(existsSync(session.outputDir)).toBe(true);
  }, 60_000);

  it('stops a session, killing ffmpeg and removing its dir (idempotent)', async () => {
    const manager = makeManager();
    const session = await startClip(manager);
    const dir = session.outputDir;

    await manager.stopSession(session.id);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);

    // Idempotent: stopping again (and an unknown id) is a no-op.
    await expect(manager.stopSession(session.id)).resolves.toBeUndefined();
    await expect(manager.stopSession('nope')).resolves.toBeUndefined();
  }, 60_000);

  it('starts a seeked session (-ss) that yields a serviceable playlist + segment', async () => {
    const manager = makeManager();
    const session = await startClip(manager, { startOffsetSec: 2 });

    expect(session.state).toBe('ready');
    expect(session.startOffsetSec).toBe(2);
    const playlist = await readFile(path.join(session.outputDir, HLS_PLAYLIST_NAME), 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(segmentsInPlaylist(playlist).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('reuses one session for the same offset and starts a DISTINCT one per offset', async () => {
    const manager = makeManager();
    const first = await startClip(manager, { startOffsetSec: 1 });
    const same = await startClip(manager, { startOffsetSec: 1 });
    const other = await startClip(manager, { startOffsetSec: 3 });

    // Same offset => reuse (same id, same dir); different offset => distinct.
    expect(same.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    // The zero-offset (default) start is distinct from any seeked one, too.
    const zero = await startClip(manager, {});
    expect(zero.id).not.toBe(first.id);
    expect(zero.id).not.toBe(other.id);
  }, 90_000);

  it('buckets sub-second offsets to whole seconds for dedup', async () => {
    const manager = makeManager();
    const a = await startClip(manager, { startOffsetSec: 2.2 });
    const b = await startClip(manager, { startOffsetSec: 2.8 });
    const c = await startClip(manager, { startOffsetSec: 3.0 });

    // 2.2 and 2.8 both bucket to whole-second 2 => reuse; 3.0 is a new bucket.
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  }, 90_000);

  it('supersedes a user\'s prior different-offset session, leaving another user untouched', async () => {
    const manager = makeManager();
    // Two users watching the SAME file at offset 0.
    const a0 = await startClip(manager, { userId: 'alice', id: 'file-shared', startOffsetSec: 0 });
    const b0 = await startClip(manager, { userId: 'bob', id: 'file-shared', startOffsetSec: 0 });
    expect(manager.activeCount).toBe(2);

    // Alice seeks: her offset-0 session is retired (freeing the slot); Bob's is not.
    const a5 = await startClip(manager, { userId: 'alice', id: 'file-shared', startOffsetSec: 5 });

    expect(manager.getSession(a0.id)).toBeUndefined();
    expect(existsSync(a0.outputDir)).toBe(false); // scratch dir cleaned
    expect(manager.getSession(b0.id)).toBeDefined(); // other user untouched
    expect(existsSync(b0.outputDir)).toBe(true);
    expect(manager.getSession(a5.id)).toBeDefined();
    // Alice still holds exactly one slot; total active is Bob + Alice's new one.
    expect(manager.activeCount).toBe(2);
  }, 90_000);

  it('supersede frees a slot so a seek does not trip the concurrency cap', async () => {
    const manager = makeManager({ maxSessions: 2 });
    // Fill the cap: one for Bob, one for Alice (both at offset 0).
    await startClip(manager, { userId: 'bob', id: 'file-b', startOffsetSec: 0 });
    const aliceStart = await startClip(manager, { userId: 'alice', id: 'file-a', startOffsetSec: 0 });
    expect(manager.activeCount).toBe(2);

    // Alice seeks her file: her old session is superseded first, so this fits
    // under the cap instead of throwing TooManySessionsError.
    const aliceSeek = await startClip(manager, { userId: 'alice', id: 'file-a', startOffsetSec: 4 });
    expect(aliceSeek.id).not.toBe(aliceStart.id);
    expect(manager.getSession(aliceStart.id)).toBeUndefined();
    expect(manager.activeCount).toBe(2);
  }, 90_000);

  it('rejects an input path outside the media roots with HlsInputError', async () => {
    const manager = makeManager();
    const outside = path.join(outsideDir, 'secret.mp4');
    await execFileAsync(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      outside,
    ]);

    const err = await manager
      .startSession({ mediaFile: { id: 'x', path: outside }, quality: '480p', userId: 'u' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlsInputError);
    expect((err as HlsInputError).reason).toBe('outside_roots');
    expect(existsSync(transcodeDir) ? await readdir(transcodeDir) : []).toEqual([]);
  }, 60_000);

  it('rejects a missing input path with a missing HlsInputError', async () => {
    const manager = makeManager();
    const err = await manager
      .startSession({
        mediaFile: { id: 'x', path: path.join(mediaRoot, 'gone.mp4') },
        quality: '480p',
        userId: 'u',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlsInputError);
    expect((err as HlsInputError).reason).toBe('missing');
  }, 60_000);

  it('shutdown stops every session and leaves no scratch dirs behind', async () => {
    const manager = makeManager();
    const a = await startClip(manager, { userId: 'a' });
    const b = await startClip(manager, { userId: 'b' });
    expect(existsSync(a.outputDir) && existsSync(b.outputDir)).toBe(true);

    await manager.shutdown();

    expect(manager.getSession(a.id)).toBeUndefined();
    expect(manager.getSession(b.id)).toBeUndefined();
    expect(existsSync(a.outputDir)).toBe(false);
    expect(existsSync(b.outputDir)).toBe(false);
  }, 60_000);
});
