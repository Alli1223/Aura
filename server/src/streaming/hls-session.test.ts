import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildHlsFfmpegArgs,
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
});

describe('quality ladder', () => {
  it('exposes 1080p / 720p / 480p with descending width caps', () => {
    expect(HLS_QUALITY_NAMES).toEqual(['1080p', '720p', '480p']);
    expect(QUALITIES['1080p'].maxWidth).toBe(1920);
    expect(QUALITIES['720p'].maxWidth).toBe(1280);
    expect(QUALITIES['480p'].maxWidth).toBe(854);
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

  const startClip = (manager: HlsSessionManager, over: Partial<{ userId: string; quality: '1080p' | '720p' | '480p'; id: string }> = {}) =>
    manager.startSession({
      mediaFile: { id: over.id ?? 'file-1', path: clipPath },
      quality: over.quality ?? '480p',
      userId: over.userId ?? 'user-1',
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
