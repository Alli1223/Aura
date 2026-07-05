import { z } from 'zod';

import { HLS_QUALITY_NAMES, QUALITIES, type HlsQualityName } from './hls-session.js';

// Playback decision engine (pure — no DB, no ffmpeg, no I/O).
//
// Given a media file's persisted stream/container info and a client's declared
// playback capabilities, decidePlayback() picks direct play vs transcode and,
// for a transcode, the smallest-honest quality rung from the HLS ladder that
// neither upscales the source nor exceeds the client's caps.
//
// A note on "container remux vs full transcode" (see the playback-decision
// roadmap item): the HLS transcoder always RE-ENCODES today, so the chosen
// action for any incompatibility is 'transcode'. We still record WHY
// (`transcodeReason`) — container/video-codec/audio-codec/resolution/bitrate —
// so the activity dashboard can show it and so a future container-only remux
// fast-path (reason === 'container' with otherwise-compatible codecs) can be
// slotted in without changing this module's callers.

/**
 * Categorical reason a file cannot be direct-played, surfaced for the activity
 * dashboard. `container` alone would be remuxable in a future fast path; today
 * every reason still results in a full transcode.
 */
export type TranscodeReason =
  'container' | 'video-codec' | 'audio-codec' | 'resolution' | 'bitrate';

/** The decision returned by decidePlayback. */
export interface PlaybackDecision {
  /** 'direct' serves the original bytes; 'transcode' starts an HLS session. */
  action: 'direct' | 'transcode';
  /** Human-readable explanation(s); always non-empty. For a transcode, one
   *  entry per failing capability check (in precedence order). */
  reasons: string[];
  /** Primary categorical reason — present only when action === 'transcode'. */
  transcodeReason?: TranscodeReason;
  /** Every categorical reason the file failed — present only for a transcode. */
  transcodeReasons?: TranscodeReason[];
  /** Chosen ladder rung — present only when action === 'transcode'. */
  quality?: HlsQualityName;
}

// ---------------------------------------------------------------------------
// Client capabilities
// ---------------------------------------------------------------------------

/**
 * What a client declares it can play directly. Every field is optional; the
 * route validates a request body against this and any omitted field falls back
 * to the conservative web-browser profile (see mergeCapabilities /
 * webBrowserProfile), so a client that sends nothing is treated as a baseline
 * h264/aac browser rather than as "plays anything".
 *
 * Codec/container tokens are matched case-insensitively through an alias table
 * (e.g. "h265" === "hevc", "matroska" === "mkv"), so clients may use either the
 * ffprobe name or the common name.
 */
export const clientCapabilitiesSchema = z.object({
  /** Playable container names, e.g. ['mp4', 'webm']. */
  containers: z.array(z.string().min(1)).optional(),
  /** Playable video codecs, e.g. ['h264', 'vp9', 'av1']. */
  videoCodecs: z.array(z.string().min(1)).optional(),
  /** Playable audio codecs, e.g. ['aac', 'opus', 'mp3']. */
  audioCodecs: z.array(z.string().min(1)).optional(),
  /** Max decodable video width in pixels. */
  maxWidth: z.number().int().positive().optional(),
  /** Max decodable video height in pixels. */
  maxHeight: z.number().int().positive().optional(),
  /** Max sustainable overall bitrate in bits per second. */
  maxBitrate: z.number().int().positive().optional(),
});

export type ClientCapabilities = z.infer<typeof clientCapabilitiesSchema>;

/**
 * Conservative default profile for a modern web browser using `<video>` +
 * hls.js: h264 video, aac audio, mp4/webm containers, up to 1080p. Used
 * whenever a client omits a capability field — a safe baseline that plays on
 * essentially every browser without a codec surprise.
 */
export function webBrowserProfile(): ClientCapabilities {
  return {
    containers: ['mp4', 'webm'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    maxWidth: 1920,
    maxHeight: 1080,
    // maxBitrate intentionally omitted — bitrate is left unconstrained unless
    // a client actually reports a ceiling.
  };
}

/** Capabilities with every field resolved (undefined -> web-browser default). */
interface ResolvedCapabilities {
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  maxWidth: number | undefined;
  maxHeight: number | undefined;
  maxBitrate: number | undefined;
}

/** Fills each omitted client field from the conservative browser profile. */
function mergeCapabilities(client: ClientCapabilities | undefined): ResolvedCapabilities {
  const base = webBrowserProfile();
  return {
    containers: client?.containers ?? base.containers ?? [],
    videoCodecs: client?.videoCodecs ?? base.videoCodecs ?? [],
    audioCodecs: client?.audioCodecs ?? base.audioCodecs ?? [],
    maxWidth: client?.maxWidth ?? base.maxWidth,
    maxHeight: client?.maxHeight ?? base.maxHeight,
    // A missing maxBitrate stays unconstrained (browsers do not report one).
    maxBitrate: client?.maxBitrate,
  };
}

// ---------------------------------------------------------------------------
// Media-side input
// ---------------------------------------------------------------------------

/** File-level fields consumed by the decision (a subset of a MediaFile row). */
export interface DecisionFile {
  /** ffprobe container/format name — may be a comma list ("matroska,webm"). */
  container: string | null | undefined;
  /** Codec of the first real video stream (e.g. "h264", "hevc"). */
  videoCodec: string | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  /** Overall bitrate in bits per second. */
  bitrate: number | null | undefined;
}

/** A stream row consumed by the decision (a subset of a MediaStream row). */
export interface DecisionStream {
  /** "video" | "audio" | "subtitle". */
  type: string;
  codec: string | null | undefined;
}

export interface DecidePlaybackParams {
  file: DecisionFile;
  streams: readonly DecisionStream[];
  /** Undefined / partial => filled from the conservative web-browser profile. */
  client?: ClientCapabilities;
}

// ---------------------------------------------------------------------------
// Codec / container normalisation
// ---------------------------------------------------------------------------

/** ffprobe and common container tokens collapsed onto one canonical name. */
const CONTAINER_ALIASES: Readonly<Record<string, string>> = {
  mp4: 'mp4',
  m4v: 'mp4',
  mov: 'mp4',
  qt: 'mp4',
  m4a: 'mp4',
  '3gp': 'mp4',
  '3g2': 'mp4',
  mj2: 'mp4',
  mkv: 'mkv',
  matroska: 'mkv',
  webm: 'webm',
  ts: 'ts',
  mpegts: 'ts',
  m2ts: 'ts',
  mts: 'ts',
  avi: 'avi',
  ogg: 'ogg',
  ogv: 'ogg',
  flv: 'flv',
  wmv: 'wmv',
  asf: 'wmv',
  mpeg: 'mpeg',
  mpg: 'mpeg',
  mpegvideo: 'mpeg',
};

/** ffprobe and common video codec tokens collapsed onto one canonical name. */
const VIDEO_CODEC_ALIASES: Readonly<Record<string, string>> = {
  h264: 'h264',
  avc: 'h264',
  avc1: 'h264',
  x264: 'h264',
  hevc: 'hevc',
  h265: 'hevc',
  hvc1: 'hevc',
  x265: 'hevc',
  vp8: 'vp8',
  vp9: 'vp9',
  vp09: 'vp9',
  av1: 'av1',
  av01: 'av1',
  mpeg4: 'mpeg4',
  msmpeg4v3: 'mpeg4',
  divx: 'mpeg4',
  xvid: 'mpeg4',
  mpeg2video: 'mpeg2',
  mpeg2: 'mpeg2',
  vc1: 'vc1',
  wmv3: 'vc1',
  theora: 'theora',
};

/** ffprobe and common audio codec tokens collapsed onto one canonical name. */
const AUDIO_CODEC_ALIASES: Readonly<Record<string, string>> = {
  aac: 'aac',
  mp4a: 'aac',
  ac3: 'ac3',
  eac3: 'eac3',
  ec3: 'eac3',
  dts: 'dts',
  dca: 'dts',
  truehd: 'truehd',
  mp3: 'mp3',
  mp3float: 'mp3',
  opus: 'opus',
  vorbis: 'vorbis',
  flac: 'flac',
  alac: 'alac',
};

function canonContainer(token: string): string {
  const key = token.trim().toLowerCase();
  return CONTAINER_ALIASES[key] ?? key;
}

function canonVideoCodec(token: string): string {
  const key = token.trim().toLowerCase();
  return VIDEO_CODEC_ALIASES[key] ?? key;
}

function canonAudioCodec(token: string): string {
  const key = token.trim().toLowerCase();
  // All PCM flavours (pcm_s16le, pcm_s24le, ...) collapse to one token.
  if (key.startsWith('pcm_')) return 'pcm';
  return AUDIO_CODEC_ALIASES[key] ?? key;
}

/** Canonical container tokens a file reports (splits the ffprobe comma list). */
function fileContainerTokens(container: string | null | undefined): Set<string> {
  if (container === null || container === undefined) return new Set();
  const tokens = container
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(canonContainer);
  return new Set(tokens);
}

/** Video codecs that make a matroska container an (webm-playable) .webm file. */
const WEBM_VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1']);

/**
 * Resolves the file's container to a single decision-relevant identity.
 *
 * ffprobe reports the SAME format_name ("matroska,webm") for both .mkv and
 * .webm files — webm is a codec-restricted subset of matroska, indistinguish-
 * able by format name alone. We disambiguate by the video codec: a matroska
 * carrying a webm video codec (vp8/vp9/av1) is treated as 'webm' (browser-
 * playable); otherwise it is treated as 'mkv' (needs transcoding for browsers).
 */
function effectiveContainerTokens(
  container: string | null | undefined,
  videoCodec: string | undefined,
): Set<string> {
  const tokens = fileContainerTokens(container);
  if (tokens.has('mkv') && tokens.has('webm')) {
    tokens.delete('mkv');
    tokens.delete('webm');
    tokens.add(videoCodec !== undefined && WEBM_VIDEO_CODECS.has(videoCodec) ? 'webm' : 'mkv');
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Capability checks
// ---------------------------------------------------------------------------

function containerSupported(
  clientContainers: string[],
  fileContainer: string | null | undefined,
  videoCodec: string | undefined,
): boolean {
  const fileTokens = effectiveContainerTokens(fileContainer, videoCodec);
  // Unknown container: cannot confirm direct play => conservative "no".
  if (fileTokens.size === 0) return false;
  const clientTokens = new Set(clientContainers.map(canonContainer));
  for (const token of fileTokens) {
    if (clientTokens.has(token)) return true;
  }
  return false;
}

/** The first video codec — file field first, else the first video stream. */
function primaryVideoCodec(
  file: DecisionFile,
  streams: readonly DecisionStream[],
): string | undefined {
  const raw =
    file.videoCodec ?? streams.find((stream) => stream.type === 'video')?.codec ?? undefined;
  if (raw === null || raw === undefined || raw.trim().length === 0) return undefined;
  return canonVideoCodec(raw);
}

/** Canonical codecs of the file's audio streams (empty when there is none). */
function audioCodecs(streams: readonly DecisionStream[]): string[] {
  return streams
    .filter((stream) => stream.type === 'audio')
    .map((stream) => stream.codec)
    .filter(
      (codec): codec is string => codec !== null && codec !== undefined && codec.trim() !== '',
    )
    .map(canonAudioCodec);
}

function videoCodecSupported(clientCodecs: string[], fileCodec: string | undefined): boolean {
  // Unknown video codec: cannot confirm direct play => conservative "no".
  if (fileCodec === undefined) return false;
  return clientCodecs.map(canonVideoCodec).includes(fileCodec);
}

/**
 * True when the file's audio is directly playable. A file with NO audio stream
 * passes (nothing to be incompatible with — the video still direct-plays).
 * Otherwise ANY one playable audio track is enough.
 */
function audioSupported(clientCodecs: string[], fileCodecs: string[]): boolean {
  if (fileCodecs.length === 0) return true;
  const playable = new Set(clientCodecs.map(canonAudioCodec));
  return fileCodecs.some((codec) => playable.has(codec));
}

function withinResolution(file: DecisionFile, caps: ResolvedCapabilities): boolean {
  if (caps.maxWidth !== undefined && file.width != null && file.width > caps.maxWidth) return false;
  if (caps.maxHeight !== undefined && file.height != null && file.height > caps.maxHeight) {
    return false;
  }
  return true;
}

function withinBitrate(file: DecisionFile, caps: ResolvedCapabilities): boolean {
  if (caps.maxBitrate === undefined || file.bitrate == null) return true;
  return file.bitrate <= caps.maxBitrate;
}

// ---------------------------------------------------------------------------
// Transcode quality selection
// ---------------------------------------------------------------------------

interface RungMeta {
  width: number;
  height: number;
  videoBps: number;
}

/** "6000k" -> 6_000_000; anything unparseable -> Infinity (never a limiter). */
function bitrateToBps(value: string): number {
  const match = /^(\d+)\s*k$/i.exec(value.trim());
  if (match !== null) return Number(match[1]) * 1000;
  const bare = Number.parseInt(value, 10);
  return Number.isFinite(bare) ? bare : Number.POSITIVE_INFINITY;
}

/**
 * Ladder metadata derived from the live HLS QUALITIES map so the decision can
 * never drift from what the transcoder actually produces. Height is the 16:9
 * partner of each width cap (1920->1080, 1280->720, 854->480).
 */
const RUNG_META: Readonly<Record<HlsQualityName, RungMeta>> = Object.fromEntries(
  HLS_QUALITY_NAMES.map((name) => {
    const quality = QUALITIES[name];
    return [
      name,
      {
        width: quality.maxWidth,
        height: Math.round((quality.maxWidth * 9) / 16),
        videoBps: bitrateToBps(quality.videoBitrate),
      } satisfies RungMeta,
    ];
  }),
) as Record<HlsQualityName, RungMeta>;

/** The smallest ladder rung (last in the descending HLS_QUALITY_NAMES list). */
const SMALLEST_RUNG: HlsQualityName = HLS_QUALITY_NAMES[HLS_QUALITY_NAMES.length - 1] ?? '480p';

export interface ChooseQualityParams {
  sourceWidth?: number;
  sourceHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxBitrate?: number;
}

/**
 * Picks the highest ladder rung that neither upscales the source nor exceeds
 * the client caps — i.e. the best quality that is still honest. When nothing is
 * known (no source dimensions and no caps) it defaults to 720p, a safe middle
 * that avoids blindly transcoding to the most expensive rung. When even the
 * smallest rung is larger than the limits, it floors at that smallest rung
 * (ffmpeg's scale filter never upscales a smaller source anyway).
 */
export function chooseTranscodeQuality(params: ChooseQualityParams): HlsQualityName {
  const limitWidth = Math.min(params.sourceWidth ?? Infinity, params.maxWidth ?? Infinity);
  const limitHeight = Math.min(params.sourceHeight ?? Infinity, params.maxHeight ?? Infinity);
  const limitBps = params.maxBitrate ?? Infinity;

  // Nothing constrains the choice: pick a conservative middle default.
  if (limitWidth === Infinity && limitHeight === Infinity && limitBps === Infinity) {
    return '720p';
  }

  for (const name of HLS_QUALITY_NAMES) {
    const rung = RUNG_META[name];
    if (rung.width <= limitWidth && rung.height <= limitHeight && rung.videoBps <= limitBps) {
      return name;
    }
  }
  return SMALLEST_RUNG;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Decides direct play vs transcode for one file against one client's
 * capabilities. Pure and deterministic. Direct play requires the container,
 * the (first) video codec, at least one audio codec, the resolution AND the
 * bitrate to all be within the client's declared capabilities; any single
 * failure means transcode. The checks run in a fixed precedence order
 * (container, video codec, audio codec, resolution, bitrate) so the primary
 * `transcodeReason` is stable.
 */
export function decidePlayback({ file, streams, client }: DecidePlaybackParams): PlaybackDecision {
  const caps = mergeCapabilities(client);

  const videoCodec = primaryVideoCodec(file, streams);
  const fileAudioCodecs = audioCodecs(streams);

  const failures: Array<{ reason: TranscodeReason; message: string }> = [];

  if (!containerSupported(caps.containers, file.container, videoCodec)) {
    failures.push({
      reason: 'container',
      message: `container "${file.container ?? 'unknown'}" is not in the client's playable containers`,
    });
  }
  if (!videoCodecSupported(caps.videoCodecs, videoCodec)) {
    failures.push({
      reason: 'video-codec',
      message: `video codec "${file.videoCodec ?? videoCodec ?? 'unknown'}" is not supported by the client`,
    });
  }
  if (!audioSupported(caps.audioCodecs, fileAudioCodecs)) {
    failures.push({
      reason: 'audio-codec',
      message: `no client-playable audio track (have [${fileAudioCodecs.join(', ')}], client plays [${caps.audioCodecs.join(', ')}])`,
    });
  }
  if (!withinResolution(file, caps)) {
    failures.push({
      reason: 'resolution',
      message: `source ${file.width ?? '?'}x${file.height ?? '?'} exceeds the client limit ${caps.maxWidth ?? '?'}x${caps.maxHeight ?? '?'}`,
    });
  }
  if (!withinBitrate(file, caps)) {
    failures.push({
      reason: 'bitrate',
      message: `source bitrate ${file.bitrate ?? '?'} bps exceeds the client max ${caps.maxBitrate ?? '?'} bps`,
    });
  }

  if (failures.length === 0) {
    return {
      action: 'direct',
      reasons: [
        'container, video, audio, resolution and bitrate are all within client capabilities',
      ],
    };
  }

  const quality = chooseTranscodeQuality({
    sourceWidth: file.width ?? undefined,
    sourceHeight: file.height ?? undefined,
    maxWidth: caps.maxWidth,
    maxHeight: caps.maxHeight,
    maxBitrate: caps.maxBitrate,
  });

  return {
    action: 'transcode',
    reasons: failures.map((failure) => failure.message),
    transcodeReason: failures[0]?.reason,
    transcodeReasons: failures.map((failure) => failure.reason),
    quality,
  };
}
