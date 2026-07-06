import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import { resolveMediaFileForServing } from '../lib/media-roots.js';
import {
  buildEncoderPlan,
  DEFAULT_HW_ACCEL,
  DEFAULT_HWACCEL_DEVICE,
  isHwAccelError,
  type HwAccelMode,
} from './hw-accel.js';
import { QUALITIES, type HlsQuality, type HlsQualityName } from './quality-ladder.js';

// The quality ladder now lives in quality-ladder.ts (the single source of truth
// shared with playback-decision). These re-exports keep hls-session's public
// surface unchanged for existing importers and tests.
export {
  HLS_QUALITY_NAMES,
  QUALITIES,
  QUALITY_LADDER,
  QUALITY_NAMES,
  isHlsQualityName,
  qualityByName,
  qualitiesUpTo,
  clampQuality,
  effectiveMaxQuality,
  qualityNameSchema,
  type HlsQuality,
  type HlsQualityName,
  type QualityRung,
} from './quality-ladder.js';

// Hardware-acceleration surface (hw-accel roadmap item). Re-exported so the
// encoder-selection primitives are reachable from hls-session's public API for
// callers and tests that already depend on this module.
export {
  HW_ACCEL_MODES,
  DEFAULT_HW_ACCEL,
  DEFAULT_HWACCEL_DEVICE,
  buildEncoderPlan,
  isHwAccelMode,
  isHwAccelError,
  hwAccelModeSchema,
  type HwAccelMode,
  type EncoderFamily,
  type EncoderPlan,
} from './hw-accel.js';

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
//
// SEEK MODEL (transcode-seek, option A — per-offset session): seeking inside a
// transcoded stream restarts the transcode window at the requested timestamp.
// A session carries a `startOffsetSec`: when it is > 0, ffmpeg is given
// `-ss <offset>` BEFORE `-i` (a fast input seek), so decoding begins at that
// point in the SOURCE. The session's own playlist is still numbered from t=0 —
// its first segment represents source content at `startOffsetSec`. The client
// is told the granted offset and maps player-time -> session-time by
// subtracting it (player wants T seconds -> fetch session time T-offset). A
// different offset is a DISTINCT session (see the dedup key); the same offset
// (bucketed to whole seconds) reuses one. When a user seeks, the manager
// SUPERSEDES that user's previous different-offset session for the same file so
// seek-spam cannot exhaust the concurrency cap (see startSession).

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

/**
 * Upper bound on output audio channels when preserving a surround source. Caps
 * a source with an exotic channel count (e.g. 7.1+ or object audio decoded to
 * many channels) at 5.1, keeping the aac encode sane and widely playable.
 */
export const MAX_TRANSCODE_AUDIO_CHANNELS = 6;

// ---------------------------------------------------------------------------
// Subtitle burn-in (subtitle-burn-in roadmap item)
// ---------------------------------------------------------------------------

/**
 * A subtitle track to BURN into the transcoded video. Burning re-renders every
 * output frame with the subtitle composited on top; because the HLS transcode
 * ALWAYS re-encodes the video, the burn is folded into the same ffmpeg via
 * `-filter_complex` (which replaces the plain `-vf` scale). Three shapes:
 *
 *  - `overlay`       — an IMAGE subtitle (PGS/HDMV, VOBSUB/DVD, DVB). The decoded
 *                      bitmap subtitle STREAM is composited onto the video with
 *                      the `overlay` filter (`[0:v:0][0:s:<n>]overlay`). This is
 *                      the ONLY way to display a bitmap sub — it cannot become
 *                      WebVTT — and is the primary purpose of this feature. The
 *                      stream index is a validated integer, so nothing untrusted
 *                      ever reaches the filtergraph.
 *  - `embedded-text` — a TEXT subtitle muxed into the SAME input file, rendered
 *                      with libass via the `subtitles` filter reading the input
 *                      at `si=<n>` (a validated integer). A convenience/bonus
 *                      path: text subs are normally served as WebVTT instead.
 *  - `external-text` — a TEXT sidecar file, rendered with the `subtitles` filter
 *                      reading that path. The path is validated to live inside a
 *                      media root by startSession before ffmpeg is spawned, and
 *                      is escaped for the filtergraph (escapeSubtitlesFilterPath)
 *                      so a crafted filename cannot inject filter syntax.
 */
export type BurnSubtitle =
  | { type: 'overlay'; subtitleIndex: number }
  | { type: 'embedded-text'; subtitleIndex: number }
  | { type: 'external-text'; filePath: string };

/** Coerces a subtitle-relative index to a safe non-negative integer (fallback 0). */
function sanitizeSubtitleIndex(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Escapes a filesystem path so it can appear as the `filename=` value of the
 * `subtitles` filter inside an ffmpeg filtergraph. ffmpeg applies TWO levels of
 * unescaping — first the whole graph (splitting on `,` `;` `[` `]`), then each
 * filter's option string (splitting on `:`) — so a literal path must be escaped
 * for BOTH: the filter-argument level first, then the graph level. Empirically
 * verified against paths containing spaces, `:`, `,`, `;`, `'`, `\`, `[` and `]`.
 * (ffmpeg is spawned with an argument array, never a shell, so this escaping is
 * purely for ffmpeg's own filtergraph parser; the path is also required to be
 * absolute — startSession passes a realpath — so an embedded `:` is never
 * mistaken for a protocol scheme.)
 */
export function escapeSubtitlesFilterPath(filePath: string): string {
  // Filter-argument level: protect `\`, `'` and the option separator `:`.
  const argLevel = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
  // Graph level: protect `\`, `'` and the graph separators `[` `]` `,` `;`.
  return argLevel
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/([[\],;])/g, '\\$1');
}

/**
 * Builds the `-filter_complex` graph that composites a burn-in subtitle onto the
 * video and then downscales the RESULT to the quality cap. The subtitle is
 * composited BEFORE the scale so a bitmap sub (authored at the source
 * resolution) stays aligned, then the whole frame scales together; the graph's
 * single output pad `[v]` is what the caller maps. `scaleExpr` is the same
 * `scale='min(iw,W)':-2` used by the non-burn `-vf` path, so scaling behaviour
 * (never upscale, even aspect-preserving height) is identical.
 */
function buildBurnFilterComplex(burn: BurnSubtitle, inputPath: string, scaleExpr: string): string {
  if (burn.type === 'overlay') {
    const index = sanitizeSubtitleIndex(burn.subtitleIndex);
    // Comma-chains overlay -> scale in a single chain (no `;`), so the graph
    // carries no shell-control character.
    return `[0:v:0][0:s:${index}]overlay,${scaleExpr}[v]`;
  }
  const file = burn.type === 'embedded-text' ? inputPath : burn.filePath;
  const si =
    burn.type === 'embedded-text' ? `:si=${sanitizeSubtitleIndex(burn.subtitleIndex)}` : '';
  return `[0:v:0]subtitles=filename=${escapeSubtitlesFilterPath(file)}${si},${scaleExpr}[v]`;
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
  /**
   * Whether the client can only play stereo. When true (the default) the audio
   * is always downmixed to 2 channels (`-ac 2`) — the universally-safe baseline
   * for `<video>`/hls.js. When false AND `sourceChannels` reports a surround
   * source (>2), the source channel count is preserved (capped at
   * MAX_TRANSCODE_AUDIO_CHANNELS) so a surround-capable client keeps 5.1/7.1.
   */
  downmixStereo?: boolean;
  /**
   * Channel count of the SELECTED source audio track (from ffprobe). Only
   * consulted when downmixStereo is false, to decide whether to preserve a
   * surround layout. Unknown/≤2 keeps the stereo baseline.
   */
  sourceChannels?: number;
  /** Segment length in seconds. Defaults to DEFAULT_HLS_SEGMENT_SECONDS. */
  segmentSeconds?: number;
  /**
   * Explicit video encoder override for `-c:v`. When set it wins over whatever
   * encoder the acceleration mode would pick (kept for flexibility / existing
   * callers). Normally left unset so `hwAccel` selects the encoder.
   */
  videoEncoder?: string;
  /** x264 preset for the SOFTWARE path. Defaults to "veryfast". */
  preset?: string;
  /**
   * Hardware-acceleration mode (hw-accel roadmap item). Defaults to `none`
   * (software libx264 — byte-for-byte the historical output). A hardware mode
   * emits the matching `-hwaccel*` input flags, hardware encoder and GPU scale
   * filter. A burn-in request always forces this back to software (see
   * buildEncoderPlan). The mode selection is the pure, unit-tested core.
   */
  hwAccel?: HwAccelMode;
  /**
   * DRM render node for VAAPI/QSV. Defaults to DEFAULT_HWACCEL_DEVICE. Ignored
   * by the software and NVENC/CUDA paths.
   */
  hwAccelDevice?: string;
  /**
   * Input seek offset in seconds (transcode-seek). When > 0 and finite, emits
   * `-ss <offset>` BEFORE `-i` so ffmpeg fast-seeks into the source and decoding
   * begins there; the produced playlist is still numbered from t=0. Omitted, 0,
   * negative, or non-finite means "transcode from the start" (no `-ss`). Callers
   * should pass an already-clamped value (see clampStartOffset).
   */
  startOffsetSec?: number;
  /**
   * A subtitle track to burn into the video (subtitle-burn-in). When present the
   * scale is moved into a `-filter_complex` that first composites the subtitle
   * and then downscales, and the filter's `[v]` output is mapped in place of the
   * raw video stream (no `-sn`, no `-vf`). Omitted transcodes with no subtitle
   * burned (the default, byte-for-byte unchanged output).
   */
  burnSubtitle?: BurnSubtitle;
}

/**
 * Formats a seconds value for ffmpeg's `-ss`: a plain fixed-point decimal
 * (digits and at most one dot), never scientific notation, so nothing exotic
 * can ever reach the argument array. Whole numbers stay integer-formatted;
 * fractional values keep up to millisecond precision with trailing zeros
 * trimmed. Callers guarantee the input is finite and >= 0.
 */
function formatSeconds(sec: number): string {
  if (Number.isInteger(sec)) return String(sec);
  return sec.toFixed(3).replace(/\.?0+$/, '');
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
  // Downmix to stereo by default (universally safe). Only when the client opts
  // out AND the source is genuinely surround do we preserve (a capped) channel
  // count; anything unknown/≤2 stays stereo.
  const downmixStereo = params.downmixStereo ?? true;
  const rawChannels = params.sourceChannels;
  const audioChannels =
    !downmixStereo && Number.isInteger(rawChannels) && (rawChannels as number) > 2
      ? Math.min(rawChannels as number, MAX_TRANSCODE_AUDIO_CHANNELS)
      : 2;
  const segmentSeconds =
    params.segmentSeconds !== undefined && params.segmentSeconds > 0
      ? params.segmentSeconds
      : DEFAULT_HLS_SEGMENT_SECONDS;
  const preset = params.preset ?? 'veryfast';
  const burn = params.burnSubtitle;

  // Encoder selection (hw-accel): the pure plan maps (mode, device) -> encoder
  // + `-hwaccel*` input flags + codec args + scale filter. A burn-in forces the
  // software path (compositing across GPU surfaces is not implemented), so the
  // proven -filter_complex path below is always reached in software. `none`
  // yields the historical libx264 pipeline byte-for-byte.
  const plan = buildEncoderPlan(
    params.hwAccel ?? DEFAULT_HW_ACCEL,
    params.hwAccelDevice ?? DEFAULT_HWACCEL_DEVICE,
    {
      hasBurnIn: burn !== undefined,
      softwarePreset: preset,
      softwareEncoder: params.videoEncoder,
    },
  );
  // An explicit encoder override still wins for `-c:v` (existing behaviour).
  const videoEncoder = params.videoEncoder ?? plan.videoEncoder;

  // Transcode-seek: a positive, finite offset becomes a fast input seek placed
  // BEFORE -i (so ffmpeg seeks the input rather than decoding-then-discarding).
  const rawOffset = params.startOffsetSec;
  const seekArgs =
    rawOffset !== undefined && Number.isFinite(rawOffset) && rawOffset > 0
      ? ['-ss', formatSeconds(rawOffset)]
      : [];

  const playlistPath = path.join(outputDir, HLS_PLAYLIST_NAME);
  const segmentPath = path.join(outputDir, HLS_SEGMENT_PATTERN);

  const scaleExpr = plan.scaleFilter(quality.maxWidth);
  // Video mapping + filter differ only for a burn-in: the subtitle is
  // composited then scaled inside a -filter_complex whose [v] output is mapped
  // in place of the raw video stream. Without a burn-in this is the original
  // `-map 0:v:0` / `-sn` / `-vf scale` path, byte-for-byte unchanged.
  const videoMap = burn === undefined ? ['-map', '0:v:0'] : ['-map', '[v]'];
  const subtitleDrop = burn === undefined ? ['-sn'] : [];
  const videoFilter =
    burn === undefined
      ? ['-vf', scaleExpr]
      : ['-filter_complex', buildBurnFilterComplex(burn, inputPath, scaleExpr)];

  // prettier-ignore
  return [
    '-nostdin',
    '-loglevel', 'error',
    // Hardware-acceleration input flags (empty for software) select the device
    // and keep decoded frames on the GPU. They are input options, so they must
    // precede -i (and the -ss fast seek, which is also an input option).
    ...plan.hwaccelArgs,
    // -ss BEFORE -i is an input option: fast seek into the source. Must precede
    // -i so it applies to the next input.
    ...seekArgs,
    '-i', inputPath,
    // First video stream (or the burned [v] filter output), plus the selected
    // audio (the trailing "?" makes the audio mapping optional so a video with
    // no audio still transcodes).
    ...videoMap,
    '-map', `0:a:${audioIndex}?`,
    ...subtitleDrop,
    '-c:v', videoEncoder,
    // Codec args: software keeps `-preset .. -profile:v high -pix_fmt yuv420p`;
    // hardware encoders keep `-profile:v high` (pixel format follows the GPU
    // surface; presets are vendor-specific so the encoder default is used).
    ...plan.videoCodecArgs,
    ...videoFilter,
    '-b:v', quality.videoBitrate,
    '-maxrate', quality.maxrate,
    '-bufsize', quality.bufsize,
    // Force a keyframe every segment so segments are independently decodable
    // and the first one flushes quickly (playback can start before the whole
    // file is transcoded).
    '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`,
    '-c:a', 'aac',
    '-ac', String(audioChannels),
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

/**
 * Clamps a requested seek offset (seconds) to the half-open window
 * [0, durationSec) that the source can actually serve. Returns the GRANTED
 * offset the transcode will start at:
 *  - undefined / non-finite / <= 0            -> 0 (transcode from the start);
 *  - duration unknown (undefined / <= 0)      -> the requested offset unchanged;
 *  - offset within the duration               -> the requested offset;
 *  - offset at or past the end                -> capped to the duration.
 * Pure and unit-tested; startSession calls it before spawning ffmpeg so the
 * granted offset (echoed to the client) is always source-valid.
 */
export function clampStartOffset(requestedSec: number | undefined, durationSec?: number): number {
  if (requestedSec === undefined || !Number.isFinite(requestedSec) || requestedSec <= 0) return 0;
  if (durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0) {
    return Math.min(requestedSec, durationSec);
  }
  return requestedSec;
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
    this.stderr =
      details.stderr === undefined || details.stderr.length === 0 ? undefined : details.stderr;
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
  /** The selected audio-relative track index mapped as `-map 0:a:<index>`. */
  readonly audioTrackIndex: number;
  /** Whether audio was downmixed to stereo for this session. */
  readonly downmixStereo: boolean;
  /**
   * Granted input seek offset (seconds) this session's transcode began at (see
   * the SEEK MODEL note at the top of this module). 0 means "from the start".
   * The playlist is numbered from t=0; the client subtracts this to map
   * player-time to session-time.
   */
  readonly startOffsetSec: number;
  /**
   * The subtitle trackId burned into this session's video, or undefined when no
   * subtitle is burned. Echoed to the client so the UI reflects the active
   * burn-in selection.
   */
  readonly burnSubtitleTrackId: string | undefined;
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
  audioTrackIndex: number;
  downmixStereo: boolean;
  startOffsetSec: number;
  burnSubtitleTrackId: string | undefined;
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
  mediaFile: {
    id: string;
    path: string;
    /**
     * Source duration in seconds, when known (from ffprobe). Only used to clamp
     * a seek offset into the servable window; omitted means "unknown", so the
     * requested offset is passed through unclamped.
     */
    durationSec?: number;
  };
  quality: HlsQualityName;
  userId: string;
  /**
   * Audio-relative track index to map (`-map 0:a:<index>`). Validated to a
   * non-negative integer; anything else falls back to the first audio track.
   * Callers should pass an index already validated against the file's audio
   * track count (the route does this via listAudioTracks/resolveAudioTrackIndex).
   */
  audioTrackIndex?: number;
  /** Force a stereo downmix (client is stereo-only). Defaults to true. */
  downmixStereo?: boolean;
  /**
   * Channel count of the selected source audio track. Only used to preserve a
   * surround layout when downmixStereo is false.
   */
  audioChannels?: number;
  /**
   * Requested seek offset in seconds (transcode-seek). Clamped to
   * [0, durationSec) via clampStartOffset; the granted result feeds `-ss` and
   * is bucketed to whole seconds in the dedup key. Omitted / <= 0 transcodes
   * from the start.
   */
  startOffsetSec?: number;
  /**
   * A subtitle track to burn into the video (subtitle-burn-in). `trackId` is the
   * public subtitle track id (from listSubtitles), used for dedup and echoed
   * back; `spec` describes how to composite it. For an `external-text` spec the
   * `filePath` is re-validated to live inside a media root before ffmpeg spawns
   * (HlsInputError otherwise). A different burned track — or none — is a DISTINCT
   * session from an otherwise-identical request (see the dedup key).
   */
  burnSubtitle?: { trackId: string; spec: BurnSubtitle };
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
  /**
   * Resolves the hardware-acceleration mode (settings.hwAccel) at start time.
   * Defaults to `none` (software). Read per-session so an admin can change it
   * without restarting. A hardware mode is attempted first and automatically
   * falls back to software on a hardware/device failure (see startSession).
   */
  getHwAccel?: () => Promise<HwAccelMode> | HwAccelMode;
  /** DRM render node for VAAPI/QSV. Defaults to DEFAULT_HWACCEL_DEVICE. */
  hwAccelDevice?: string;
  logger?: FastifyBaseLogger;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /**
   * Process spawner (seam for tests). Defaults to node's `spawn`. Injected in
   * unit tests to simulate a hardware failure followed by a software success
   * without a real GPU or ffmpeg.
   */
  spawnFn?: typeof spawn;
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
  private readonly getHwAccel: () => Promise<HwAccelMode> | HwAccelMode;
  private readonly hwAccelDevice: string;
  private readonly spawnFn: typeof spawn;
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
    this.getHwAccel = options.getHwAccel ?? (() => DEFAULT_HW_ACCEL);
    this.hwAccelDevice = options.hwAccelDevice ?? DEFAULT_HWACCEL_DEVICE;
    this.spawnFn = options.spawnFn ?? spawn;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;

    const reaperEvery = options.reaperIntervalMs ?? Math.min(this.idleMs, 15_000);
    this.reaperInterval = setInterval(
      () => {
        void this.reapIdleSessions();
      },
      Math.max(reaperEvery, 100),
    );
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
   * Reuse: an identical request — same (userId, mediaFileId, quality, audio
   * track, downmix, seek-offset-bucket) — that is still starting/ready returns
   * the existing session (same id, same ffmpeg) instead of spawning a second
   * process. Reuse is checked before the concurrency cap.
   *
   * Seek supersede: starting a DIFFERENT seek offset for the same (user, file)
   * first stops that user's previous different-offset session for the file,
   * freeing its slot (so a client seeking repeatedly cannot exhaust the cap).
   * See supersedePriorOffsetSessions.
   *
   * Rejects with TooManySessionsError (cap), HlsInputError (path missing or
   * outside the media roots), or HlsStartError (ffmpeg produced no playlist).
   */
  async startSession({
    mediaFile,
    quality,
    userId,
    audioTrackIndex,
    downmixStereo,
    audioChannels,
    startOffsetSec,
    burnSubtitle,
  }: StartSessionParams): Promise<HlsSession> {
    if (this.stopped) throw new HlsStartError('session manager is shut down');

    const resolvedAudioIndex =
      audioTrackIndex !== undefined && Number.isInteger(audioTrackIndex) && audioTrackIndex >= 0
        ? audioTrackIndex
        : 0;
    const resolvedDownmix = downmixStereo ?? true;

    // Clamp the requested seek into the source's servable window; the granted
    // offset is what `-ss` uses and what is echoed to the client. The dedup key
    // buckets it to whole seconds so sub-second differences reuse one session
    // while a real seek starts a distinct one.
    const grantedOffsetSec = clampStartOffset(startOffsetSec, mediaFile.durationSec);
    const offsetBucket = Math.floor(grantedOffsetSec);

    // audioTrackIndex, downmix, the seek offset AND the burned subtitle each
    // change the produced stream, so all are part of the dedup identity:
    // switching any must start a DISTINCT session rather than reuse one built
    // differently. The burn field is `b<trackId>` (or a bare `b` for no burn),
    // so a burn-in session never reuses a no-subs one, nor a different track's.
    // NUL-delimited so no field value can ever bleed into an adjacent one.
    const dedupKey = [
      userId,
      mediaFile.id,
      quality,
      `a${resolvedAudioIndex}`,
      `d${resolvedDownmix ? 1 : 0}`,
      `o${offsetBucket}`,
      `b${burnSubtitle?.trackId ?? ''}`,
    ].join('\0');
    const existingId = this.byKey.get(dedupKey);
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId);
      if (existing !== undefined && (existing.state === 'starting' || existing.state === 'ready')) {
        existing.lastAccess = this.now();
        await existing.ready;
        return existing;
      }
    }

    // Seek supersede (runs BEFORE the cap check so a freed slot is reusable):
    // retire this user's other live sessions for THIS file that sit at a
    // different offset bucket. Another user's sessions, and this user's sessions
    // for other files or at the same offset, are left alone.
    await this.supersedePriorOffsetSessions(userId, mediaFile.id, offsetBucket);

    if (this.activeCount >= this.maxSessions) {
      throw new TooManySessionsError(this.maxSessions);
    }

    // Realpath-resolve and containment-check the input BEFORE spawning ffmpeg.
    const resolution = await resolveMediaFileForServing(mediaFile.path, this.mediaRoots);
    if (!resolution.ok) throw new HlsInputError(resolution.reason);
    const inputPath = resolution.canonicalPath;

    // Resolve the burn-in spec (if any) BEFORE creating the scratch dir so a bad
    // subtitle path leaves nothing behind. Embedded specs reference the already-
    // validated input by stream index; an external sidecar path is re-validated
    // to live inside a media root (defence in depth) and the canonical path is
    // what ffmpeg reads.
    let burnSpec: BurnSubtitle | undefined;
    if (burnSubtitle !== undefined) {
      if (burnSubtitle.spec.type === 'external-text') {
        const subResolution = await resolveMediaFileForServing(
          burnSubtitle.spec.filePath,
          this.mediaRoots,
        );
        if (!subResolution.ok) throw new HlsInputError(subResolution.reason);
        burnSpec = { type: 'external-text', filePath: subResolution.canonicalPath };
      } else {
        burnSpec = burnSubtitle.spec;
      }
    }

    // sessionId is a server-generated UUID — never user input — so the scratch
    // path can never traverse out of the transcode dir.
    const id = randomUUID();
    const transcodeDir = await this.getTranscodeDir();
    const outputDir = path.join(transcodeDir, id);
    await mkdir(outputDir, { recursive: true });

    // Encoder selection (hw-accel): read the mode per-session so an admin can
    // change it live. A hardware mode is ATTEMPTED first, then automatically
    // falls back to software on a hardware/device failure (see runStart). A
    // burn-in always transcodes in software (buildEncoderPlan enforces this), so
    // there is nothing to fall back FROM — the hardware attempt is skipped.
    const requestedHwAccel = await this.getHwAccel();
    const attemptHw = requestedHwAccel !== 'none' && burnSpec === undefined;
    const buildArgs = (hwAccel: HwAccelMode): string[] =>
      buildHlsFfmpegArgs({
        inputPath,
        quality: this.qualities[quality],
        outputDir,
        segmentSeconds: this.segmentSeconds,
        audioStreamIndex: resolvedAudioIndex,
        downmixStereo: resolvedDownmix,
        sourceChannels: audioChannels,
        startOffsetSec: grantedOffsetSec,
        burnSubtitle: burnSpec,
        hwAccel,
        hwAccelDevice: this.hwAccelDevice,
      });

    const firstMode: HwAccelMode = attemptHw ? requestedHwAccel : 'none';
    const child = this.spawnFfmpeg(buildArgs(firstMode));

    const nowMs = this.now();
    const session: InternalSession = {
      id,
      mediaFileId: mediaFile.id,
      userId,
      quality,
      audioTrackIndex: resolvedAudioIndex,
      downmixStereo: resolvedDownmix,
      startOffsetSec: grantedOffsetSec,
      burnSubtitleTrackId: burnSubtitle?.trackId,
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

    session.ready = this.runStart(session, attemptHw, buildArgs);
    await session.ready;
    return session;
  }

  /**
   * Orchestrates a session start with automatic software fallback: awaits the
   * first attempt's readiness, and — only when that attempt was HARDWARE and it
   * failed with a hardware/device error — retries ONCE with software args. A
   * non-hardware failure (bad input, codec error) is finalised immediately and
   * never retried, so no failure can loop. On success `session.process` is the
   * live ffmpeg; on final failure the session is cleaned up and the error is
   * rethrown for startSession's caller.
   */
  private async runStart(
    session: InternalSession,
    attemptHw: boolean,
    buildArgs: (hwAccel: HwAccelMode) => string[],
  ): Promise<void> {
    try {
      await this.beginAttempt(session);
      return;
    } catch (err) {
      const stderr = err instanceof HlsStartError ? err.stderr : undefined;
      // No hardware attempt, or a non-hardware failure, or the session was
      // stopped mid-start: finalise without retrying.
      if (!attemptHw || this.stopped || session.state === 'stopped' || !isHwAccelError(stderr)) {
        throw await this.finalizeStartFailure(session, err);
      }
      this.logger?.warn(
        { sessionId: session.id, err },
        'hardware transcode failed; falling back to software encoding',
      );
    }

    // Software fallback: clear any partial hardware output, then re-spawn with
    // software args on the SAME session id / scratch dir.
    await this.resetOutputDir(session);
    session.stderrTail = '';
    session.process = this.spawnFfmpeg(buildArgs('none'));
    try {
      await this.beginAttempt(session);
    } catch (err) {
      throw await this.finalizeStartFailure(session, err);
    }
  }

  /** Spawns ffmpeg (via the injectable spawner) and tracks the child. */
  private spawnFfmpeg(args: string[]): ChildProcess {
    const child = this.spawnFn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    trackChild(child);
    return child;
  }

  /**
   * Wires the current `session.process` (stderr capture + exit/error handlers,
   * each guarded by child identity so a superseded attempt's late events are
   * ignored) and returns a promise that resolves once the playlist is
   * serviceable or rejects with an HlsStartError. Does NOT clean up on failure —
   * runStart decides whether to retry or finalise.
   */
  private beginAttempt(session: InternalSession): Promise<void> {
    const child = session.process;
    session.processAlive = true;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_LENGTH);
    });
    child.on('error', (err) => this.onChildError(session, child, err));
    child.on('exit', (code, signal) => {
      void this.onChildExit(session, child, code, signal);
    });
    return this.awaitReadiness(session);
  }

  /** Finalises a failed start: marks the session errored and cleans it up. */
  private async finalizeStartFailure(session: InternalSession, err: unknown): Promise<Error> {
    if (session.state !== 'stopped') session.state = 'error';
    await this.cleanupSession(session);
    return err instanceof Error ? err : new HlsStartError(String(err));
  }

  /** Empties the session scratch dir so a fallback attempt starts clean. */
  private async resetOutputDir(session: InternalSession): Promise<void> {
    try {
      await rm(session.outputDir, { recursive: true, force: true });
    } catch (err) {
      this.logger?.debug({ err, sessionId: session.id }, 'failed to reset HLS scratch dir');
    }
    await mkdir(session.outputDir, { recursive: true });
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

  /**
   * Seek supersede: stops the given user's live sessions for `mediaFileId` whose
   * seek offset bucket differs from `keepOffsetBucket`. Scoped strictly to the
   * (user, file) pair — a DIFFERENT user's sessions, and the same user's
   * sessions for other files or already at `keepOffsetBucket`, are never
   * touched. This bounds a seeking client to one live transcode per file, so
   * rapid seeks cannot ratchet the concurrency cap (HLS_MAX_SESSIONS) upward.
   */
  private async supersedePriorOffsetSessions(
    userId: string,
    mediaFileId: string,
    keepOffsetBucket: number,
  ): Promise<void> {
    const toStop: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.mediaFileId !== mediaFileId) continue;
      if (session.state !== 'starting' && session.state !== 'ready') continue;
      if (Math.floor(session.startOffsetSec) === keepOffsetBucket) continue;
      toStop.push(session.id);
    }
    await Promise.all(toStop.map((id) => this.stopSession(id)));
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
        // Reject the attempt and kill the stalled ffmpeg, but leave the session
        // in 'starting' and DON'T clean up: runStart decides whether to fall
        // back to software or finalise (a superseded attempt's child is killed
        // here; its scratch dir is either reused by the retry or removed by the
        // final cleanup).
        const err = new HlsStartError(
          `HLS transcode did not produce a playlist within ${this.readinessTimeoutMs}ms`,
          { stderr: session.stderrTail },
        );
        this.settleReject(session, err);
        void this.killProcess(session);
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

  private onChildError(session: InternalSession, child: ChildProcess, err: Error): void {
    untrackChild(child);
    this.logger?.debug({ err, sessionId: session.id }, 'ffmpeg process error');
    // Ignore a superseded attempt's late error (its child was replaced by the
    // software fallback's child).
    if (child !== session.process) return;
    session.processAlive = false;
    if (session.state === 'starting') {
      // Reject the attempt; runStart finalises or falls back (no cleanup here).
      this.settleReject(
        session,
        new HlsStartError(`ffmpeg failed to start: ${err.message}`, { stderr: session.stderrTail }),
      );
    }
  }

  private async onChildExit(
    session: InternalSession,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    untrackChild(child);
    // Ignore a superseded attempt's exit (e.g. the killed hardware child after
    // the session moved on to the software fallback child).
    if (child !== session.process) return;
    session.processAlive = false;

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
    // Reject the attempt; runStart decides whether to retry in software or
    // finalise (so a failed HARDWARE attempt can fall back rather than error).
    this.settleReject(
      session,
      new HlsStartError(
        `ffmpeg exited before producing a playlist (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        { stderr: session.stderrTail, exitCode: code },
      ),
    );
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
