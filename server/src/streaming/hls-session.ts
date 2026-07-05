import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import { resolveMediaFileForServing } from '../lib/media-roots.js';

// ffmpeg HLS transcoding session manager.
//
// A session owns one ffmpeg child process that transcodes one media file to a
// growing (EVENT-type) HLS playlist under a per-session scratch dir. The
// manager tracks live sessions, enforces a concurrency cap, deduplicates
// identical requests onto a single ffmpeg, reaps idle sessions, and guarantees
// no ffmpeg process or scratch dir is ever leaked (idle reap, explicit stop,
// server shutdown, and a last-resort process-exit SIGKILL all clean up).
//
// SECURITY (see CLAUDE.md): ffmpeg is always spawned with an ARGUMENT ARRAY —
// never a shell string — so no input can be interpreted by a shell. The input
// path is realpath-resolved and asserted to live inside a configured media
// root before ffmpeg is spawned (media roots are read-only). Every scratch
// path is built from a server-generated session id (randomUUID), never from
// user input.

/** Segment target duration (seconds). ffmpeg cuts a new segment at each. */
export const DEFAULT_HLS_SEGMENT_SECONDS = 4;

/** How often the readiness poller checks the scratch dir while starting. */
const READINESS_POLL_MS = 150;

/** Default budget for the first playlist+segment to appear before giving up. */
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;

/** Grace between SIGTERM and SIGKILL when stopping an ffmpeg. */
const DEFAULT_KILL_GRACE_MS = 3_000;

/** Trailing ffmpeg stderr kept for diagnosing a failed start. */
const STDERR_TAIL_LENGTH = 4_000;

/** Playlist filename ffmpeg writes and the routes serve. */
export const HLS_PLAYLIST_NAME = 'index.m3u8';

/** Segment filename pattern (printf-style) ffmpeg writes. */
export const HLS_SEGMENT_PATTERN = 'segment%05d.ts';

// ---------------------------------------------------------------------------
// Quality ladder
// ---------------------------------------------------------------------------

/** Named quality presets. The quality-ladder roadmap item makes these configurable. */
export type HlsQualityName = '1080p' | '720p' | '480p';

/** One quality rung: a width cap plus video/audio bitrate targets. */
export interface HlsQuality {
  /** Maximum output width. The source is only ever downscaled to this. */
  readonly maxWidth: number;
  /** Target (average) video bitrate, e.g. "6000k". */
  readonly videoBitrate: string;
  /** VBV peak bitrate cap. */
  readonly maxrate: string;
  /** VBV buffer size. */
  readonly bufsize: string;
  /** Stereo AAC audio bitrate, e.g. "192k". */
  readonly audioBitrate: string;
}

/**
 * The quality ladder used by the HLS transcoder. Widths are caps: a source
 * narrower than the cap is never upscaled (the scale filter uses
 * min(iw, maxWidth)). Bitrates are software-x264 targets.
 */
export const QUALITIES: Readonly<Record<HlsQualityName, HlsQuality>> = {
  '1080p': {
    maxWidth: 1920,
    videoBitrate: '6000k',
    maxrate: '6000k',
    bufsize: '12000k',
    audioBitrate: '192k',
  },
  '720p': {
    maxWidth: 1280,
    videoBitrate: '3000k',
    maxrate: '3000k',
    bufsize: '6000k',
    audioBitrate: '160k',
  },
  '480p': {
    maxWidth: 854,
    videoBitrate: '1400k',
    maxrate: '1400k',
    bufsize: '2800k',
    audioBitrate: '128k',
  },
};

/** All quality names, in descending order. */
export const HLS_QUALITY_NAMES = Object.keys(QUALITIES) as HlsQualityName[];

/** Narrows an arbitrary string to a known quality name. */
export function isHlsQualityName(value: string): value is HlsQualityName {
  return Object.prototype.hasOwnProperty.call(QUALITIES, value);
}

// ---------------------------------------------------------------------------
// ffmpeg argument builder (pure — no spawning, exhaustively unit-tested)
// ---------------------------------------------------------------------------

export interface BuildHlsArgsParams {
  /** Absolute, already-validated input path. Positioned immediately after -i. */
  inputPath: string;
  /** Chosen quality rung. */
  quality: HlsQuality;
  /** Per-session scratch dir the playlist and segments are written into. */
  outputDir: string;
  /**
   * 0-based audio-relative stream index to map (`0:a:<n>`). Defaults to 0
   * (first audio). The audio-tracks roadmap item wires selection through here.
   */
  audioStreamIndex?: number;
  /** Segment length in seconds. Defaults to DEFAULT_HLS_SEGMENT_SECONDS. */
  segmentSeconds?: number;
  /**
   * Video encoder. Defaults to software libx264. The hw-accel roadmap item
   * slots a hardware encoder (e.g. h264_vaapi) in here without touching the
   * rest of the pipeline.
   */
  videoEncoder?: string;
  /** x264 preset. Defaults to "veryfast" (good speed/quality for live HLS). */
  preset?: string;
}

/**
 * Builds the full ffmpeg argument array for one HLS transcode. Pure: it only
 * assembles strings, so it can be unit-tested without spawning. Every element
 * is a separate array entry — nothing is ever concatenated into a shell
 * command — so no value can be shell-interpreted.
 *
 * The scale filter is `scale='min(iw,W)':-2`: it downscales width to at most W
 * (never upscaling a smaller source) and derives an even height that preserves
 * the aspect ratio. The single quotes are ffmpeg filtergraph escaping (they
 * protect the comma inside min()), consumed by ffmpeg's own parser.
 */
export function buildHlsFfmpegArgs(params: BuildHlsArgsParams): string[] {
  const { inputPath, quality, outputDir } = params;
  const rawAudioIndex = params.audioStreamIndex ?? 0;
  const audioIndex = Number.isInteger(rawAudioIndex) && rawAudioIndex >= 0 ? rawAudioIndex : 0;
  const segmentSeconds =
    params.segmentSeconds !== undefined && params.segmentSeconds > 0
      ? params.segmentSeconds
      : DEFAULT_HLS_SEGMENT_SECONDS;
  const videoEncoder = params.videoEncoder ?? 'libx264';
  const preset = params.preset ?? 'veryfast';

  const playlistPath = path.join(outputDir, HLS_PLAYLIST_NAME);
  const segmentPath = path.join(outputDir, HLS_SEGMENT_PATTERN);

  // prettier-ignore
  return [
    '-nostdin',
    '-loglevel', 'error',
    '-i', inputPath,
    // First video stream, plus the selected audio (the trailing "?" makes the
    // audio mapping optional so a video with no audio still transcodes).
    '-map', '0:v:0',
    '-map', `0:a:${audioIndex}?`,
    '-sn',
    '-c:v', videoEncoder,
    '-preset', preset,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-vf', `scale='min(iw,${quality.maxWidth})':-2`,
    '-b:v', quality.videoBitrate,
    '-maxrate', quality.maxrate,
    '-bufsize', quality.bufsize,
    // Force a keyframe every segment so segments are independently decodable
    // and the first one flushes quickly (playback can start before the whole
    // file is transcoded).
    '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`,
    '-c:a', 'aac',
    '-ac', '2',
    '-b:a', quality.audioBitrate,
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    // EVENT: a growing live playlist so clients can start before completion.
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segmentPath,
    playlistPath,
  ];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when starting a session would exceed the concurrency cap (=> 503). */
export class TooManySessionsError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`HLS transcode session limit reached (${limit})`);
    this.name = 'TooManySessionsError';
    this.limit = limit;
  }
}

/** Thrown when the input path is gone or escapes the media roots (=> 404 cloak). */
export class HlsInputError extends Error {
  readonly reason: 'missing' | 'outside_roots';
  constructor(reason: 'missing' | 'outside_roots') {
    super(`HLS input unavailable: ${reason}`);
    this.name = 'HlsInputError';
    this.reason = reason;
  }
}

/** Thrown when ffmpeg fails to produce a playlist (exit before ready / timeout). */
export class HlsStartError extends Error {
  readonly stderr: string | undefined;
  readonly exitCode: number | null | undefined;
  constructor(message: string, details: { stderr?: string; exitCode?: number | null } = {}) {
    super(message);
    this.name = 'HlsStartError';
    this.stderr = details.stderr === undefined || details.stderr.length === 0 ? undefined : details.stderr;
    this.exitCode = details.exitCode;
  }
}

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/**
 * Session lifecycle:
 *  - `starting`: ffmpeg spawned, waiting for the first playlist+segment.
 *  - `ready`:    playlist is serviceable (ffmpeg may still be running, or may
 *                have finished the whole VOD — the files stay on disk either
 *                way until the session is stopped or reaped).
 *  - `error`:    ffmpeg failed before producing a playlist (dir cleaned up).
 *  - `stopped`:  explicitly stopped or reaped (dir cleaned up).
 */
export type HlsSessionState = 'starting' | 'ready' | 'error' | 'stopped';

/** Public, read-only view of a session. */
export interface HlsSession {
  readonly id: string;
  readonly mediaFileId: string;
  readonly userId: string;
  readonly quality: HlsQualityName;
  /** Absolute, containment-checked input path passed to ffmpeg. */
  readonly inputPath: string;
  /** Absolute scratch dir holding the playlist and segments. */
  readonly outputDir: string;
  readonly createdAt: number;
  readonly lastAccess: number;
  readonly state: HlsSessionState;
}

interface InternalSession {
  id: string;
  mediaFileId: string;
  userId: string;
  quality: HlsQualityName;
  inputPath: string;
  outputDir: string;
  createdAt: number;
  lastAccess: number;
  state: HlsSessionState;
  dedupKey: string;
  process: ChildProcess;
  processAlive: boolean;
  stderrTail: string;
  ready: Promise<void>;
  readyResolve?: () => void;
  readyReject?: (err: Error) => void;
  readinessInterval?: NodeJS.Timeout;
  readinessTimeout?: NodeJS.Timeout;
}

export interface StartSessionParams {
  mediaFile: { id: string; path: string };
  quality: HlsQualityName;
  userId: string;
}

export interface HlsSessionManagerOptions {
  /** Configured media roots; the input path must realpath inside one. */
  mediaRoots: readonly string[];
  /** Resolves the scratch dir root (settings.transcodeDir) at start time. */
  getTranscodeDir: () => Promise<string> | string;
  /** ffmpeg binary. Defaults to FFMPEG_PATH env or "ffmpeg". */
  ffmpegPath?: string;
  /** Quality ladder. Defaults to QUALITIES. */
  qualities?: Readonly<Record<HlsQualityName, HlsQuality>>;
  /** Idle timeout before a session is reaped. */
  idleMs?: number;
  /** Concurrency cap. */
  maxSessions?: number;
  /** Budget for the first playlist to appear when starting. */
  readinessTimeoutMs?: number;
  /** SIGTERM->SIGKILL grace when stopping. */
  killGraceMs?: number;
  /** Segment duration in seconds. */
  segmentSeconds?: number;
  /** How often the idle reaper runs. Defaults to min(idleMs, 15s). */
  reaperIntervalMs?: number;
  logger?: FastifyBaseLogger;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Last-resort orphan protection: one process-exit listener SIGKILLs any child
// still tracked. Registered once, module-wide, so many manager instances (as
// in the test suite) never accumulate listeners.
// ---------------------------------------------------------------------------

const liveChildren = new Set<ChildProcess>();
let exitHandlerRegistered = false;

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.on('exit', () => {
      for (const child of liveChildren) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Best effort on the way out.
        }
      }
    });
  }
}

function untrackChild(child: ChildProcess): void {
  liveChildren.delete(child);
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class HlsSessionManager {
  private readonly sessions = new Map<string, InternalSession>();
  /** dedupKey -> sessionId for reusing identical (user,file,quality) requests. */
  private readonly byKey = new Map<string, string>();

  private readonly mediaRoots: readonly string[];
  private readonly getTranscodeDir: () => Promise<string> | string;
  private readonly ffmpegPath: string;
  private readonly qualities: Readonly<Record<HlsQualityName, HlsQuality>>;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly readinessTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly segmentSeconds: number;
  private readonly logger: FastifyBaseLogger | undefined;
  private readonly now: () => number;
  private readonly reaperInterval: NodeJS.Timeout;
  private stopped = false;

  constructor(options: HlsSessionManagerOptions) {
    this.mediaRoots = options.mediaRoots;
    this.getTranscodeDir = options.getTranscodeDir;
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.qualities = options.qualities ?? QUALITIES;
    this.idleMs = options.idleMs ?? 60_000;
    this.maxSessions = options.maxSessions ?? 3;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.segmentSeconds = options.segmentSeconds ?? DEFAULT_HLS_SEGMENT_SECONDS;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;

    const reaperEvery = options.reaperIntervalMs ?? Math.min(this.idleMs, 15_000);
    this.reaperInterval = setInterval(() => {
      void this.reapIdleSessions();
    }, Math.max(reaperEvery, 100));
    // Never keep the event loop (or a test runner) alive just for the reaper.
    this.reaperInterval.unref();
  }

  /** Sessions currently holding resources (starting or serviceable). */
  get activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'starting' || session.state === 'ready') count += 1;
    }
    return count;
  }

  /** The live session for an id, or undefined. Includes serviceable sessions. */
  getSession(sessionId: string): HlsSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
    if (session.state !== 'starting' && session.state !== 'ready') return undefined;
    return session;
  }

  /** Bumps lastAccess so the reaper does not kill an in-use session. */
  touch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    session.lastAccess = this.now();
    return true;
  }

  /**
   * Starts (or reuses) a transcode session and resolves once its playlist is
   * serviceable (playlist file exists and lists at least one segment).
   *
   * Reuse: an identical (userId, mediaFileId, quality) request that is still
   * starting/ready returns the existing session (same id, same ffmpeg) instead
   * of spawning a second process. Reuse is checked before the concurrency cap.
   *
   * Rejects with TooManySessionsError (cap), HlsInputError (path missing or
   * outside the media roots), or HlsStartError (ffmpeg produced no playlist).
   */
  async startSession({ mediaFile, quality, userId }: StartSessionParams): Promise<HlsSession> {
    if (this.stopped) throw new HlsStartError('session manager is shut down');

    const dedupKey = `${userId} ${mediaFile.id} ${quality}`;
    const existingId = this.byKey.get(dedupKey);
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId);
      if (existing !== undefined && (existing.state === 'starting' || existing.state === 'ready')) {
        existing.lastAccess = this.now();
        await existing.ready;
        return existing;
      }
    }

    if (this.activeCount >= this.maxSessions) {
      throw new TooManySessionsError(this.maxSessions);
    }

    // Realpath-resolve and containment-check the input BEFORE spawning ffmpeg.
    const resolution = await resolveMediaFileForServing(mediaFile.path, this.mediaRoots);
    if (!resolution.ok) throw new HlsInputError(resolution.reason);
    const inputPath = resolution.canonicalPath;

    // sessionId is a server-generated UUID — never user input — so the scratch
    // path can never traverse out of the transcode dir.
    const id = randomUUID();
    const transcodeDir = await this.getTranscodeDir();
    const outputDir = path.join(transcodeDir, id);
    await mkdir(outputDir, { recursive: true });

    const args = buildHlsFfmpegArgs({
      inputPath,
      quality: this.qualities[quality],
      outputDir,
      segmentSeconds: this.segmentSeconds,
    });
    const child = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    trackChild(child);

    const nowMs = this.now();
    const session: InternalSession = {
      id,
      mediaFileId: mediaFile.id,
      userId,
      quality,
      inputPath,
      outputDir,
      createdAt: nowMs,
      lastAccess: nowMs,
      state: 'starting',
      dedupKey,
      process: child,
      processAlive: true,
      stderrTail: '',
      ready: Promise.resolve(),
    };
    this.sessions.set(id, session);
    this.byKey.set(dedupKey, id);

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_LENGTH);
    });
    child.on('error', (err) => this.onChildError(session, err));
    child.on('exit', (code, signal) => {
      void this.onChildExit(session, code, signal);
    });

    session.ready = this.awaitReadiness(session);
    await session.ready;
    return session;
  }

  /**
   * Stops a session: kills ffmpeg (SIGTERM then SIGKILL) and removes its
   * scratch dir. Idempotent — stopping an unknown or already-stopped session
   * is a no-op.
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.state === 'stopped') return;
    session.state = 'stopped';

    this.clearReadinessTimers(session);
    if (session.readyReject !== undefined) {
      const reject = session.readyReject;
      session.readyResolve = undefined;
      session.readyReject = undefined;
      reject(new HlsStartError('session stopped before it became ready'));
    }

    await this.killProcess(session);
    await this.cleanupSession(session);
  }

  /** Kills and removes every session whose lastAccess is older than idleMs. */
  async reapIdleSessions(): Promise<void> {
    const now = this.now();
    const stale: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.state === 'stopped' || session.state === 'error') continue;
      if (now - session.lastAccess >= this.idleMs) stale.push(session.id);
    }
    await Promise.all(stale.map((id) => this.stopSession(id)));
  }

  /** Stops the reaper and every session. Call on server shutdown. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.reaperInterval);
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stopSession(id)));
  }

  // -- internals ------------------------------------------------------------

  private awaitReadiness(session: InternalSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      session.readyResolve = resolve;
      session.readyReject = reject;

      session.readinessInterval = setInterval(() => {
        void this.checkReadiness(session);
      }, READINESS_POLL_MS);
      session.readinessInterval.unref();

      session.readinessTimeout = setTimeout(() => {
        if (session.state !== 'starting') return;
        session.state = 'error';
        const err = new HlsStartError(
          `HLS transcode did not produce a playlist within ${this.readinessTimeoutMs}ms`,
          { stderr: session.stderrTail },
        );
        this.settleReject(session, err);
        void this.killProcess(session).then(() => this.cleanupSession(session));
      }, this.readinessTimeoutMs);
      session.readinessTimeout.unref();

      // Immediate first check in case ffmpeg was extremely fast.
      void this.checkReadiness(session);
    });
  }

  private async checkReadiness(session: InternalSession): Promise<void> {
    if (session.state !== 'starting') return;
    const ready = await this.isPlaylistReady(session.outputDir);
    if (ready && session.state === 'starting') {
      session.state = 'ready';
      this.settleResolve(session);
    }
  }

  private async isPlaylistReady(outputDir: string): Promise<boolean> {
    try {
      await access(path.join(outputDir, HLS_PLAYLIST_NAME));
    } catch {
      return false;
    }
    // The playlist file can exist before it references any segment; require it
    // to list at least one .ts so a client that fetches it has a segment.
    try {
      const text = await readFile(path.join(outputDir, HLS_PLAYLIST_NAME), 'utf8');
      return text.includes('.ts');
    } catch {
      return false;
    }
  }

  private onChildError(session: InternalSession, err: Error): void {
    session.processAlive = false;
    untrackChild(session.process);
    this.logger?.debug({ err, sessionId: session.id }, 'ffmpeg process error');
    if (session.state === 'starting') {
      session.state = 'error';
      this.clearReadinessTimers(session);
      this.settleReject(
        session,
        new HlsStartError(`ffmpeg failed to start: ${err.message}`, { stderr: session.stderrTail }),
      );
      void this.cleanupSession(session);
    }
  }

  private async onChildExit(
    session: InternalSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    session.processAlive = false;
    untrackChild(session.process);

    if (session.state !== 'starting') {
      // Already ready (VOD finished — files stay on disk, serviceable until
      // reaped/stopped), or already stopped/errored. Nothing to do.
      return;
    }

    // Exited while still starting: either it finished a tiny clip before the
    // poller saw the playlist (success) or it died (failure).
    const ready = await this.isPlaylistReady(session.outputDir);
    if (ready) {
      session.state = 'ready';
      this.settleResolve(session);
      return;
    }
    session.state = 'error';
    this.settleReject(
      session,
      new HlsStartError(
        `ffmpeg exited before producing a playlist (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        { stderr: session.stderrTail, exitCode: code },
      ),
    );
    await this.cleanupSession(session);
  }

  private settleResolve(session: InternalSession): void {
    this.clearReadinessTimers(session);
    const resolve = session.readyResolve;
    session.readyResolve = undefined;
    session.readyReject = undefined;
    resolve?.();
  }

  private settleReject(session: InternalSession, err: Error): void {
    this.clearReadinessTimers(session);
    const reject = session.readyReject;
    session.readyResolve = undefined;
    session.readyReject = undefined;
    reject?.(err);
  }

  private clearReadinessTimers(session: InternalSession): void {
    if (session.readinessInterval !== undefined) {
      clearInterval(session.readinessInterval);
      session.readinessInterval = undefined;
    }
    if (session.readinessTimeout !== undefined) {
      clearTimeout(session.readinessTimeout);
      session.readinessTimeout = undefined;
    }
  }

  private killProcess(session: InternalSession): Promise<void> {
    const child = session.process;
    if (!session.processAlive || child.exitCode !== null || child.signalCode !== null) {
      untrackChild(child);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          resolve();
        }
      }, this.killGraceMs);
      killTimer.unref();
      const done = (): void => {
        clearTimeout(killTimer);
        resolve();
      };
      child.once('exit', done);
      try {
        child.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  private async cleanupSession(session: InternalSession): Promise<void> {
    this.sessions.delete(session.id);
    if (this.byKey.get(session.dedupKey) === session.id) this.byKey.delete(session.dedupKey);
    untrackChild(session.process);
    try {
      await rm(session.outputDir, { recursive: true, force: true });
    } catch (err) {
      this.logger?.debug({ err, sessionId: session.id }, 'failed to remove HLS scratch dir');
    }
  }
}
