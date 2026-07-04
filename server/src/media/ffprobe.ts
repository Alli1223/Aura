import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

import { z } from 'zod';

// ffprobe-based media analysis. Spawns the ffprobe binary (never a shell) with
// an argument array, parses its JSON output through zod and maps it to the
// typed ProbeResult consumed by the scanner and the transcode decision engine.
//
// The binary location is configurable via the FFPROBE_PATH environment
// variable (default: "ffprobe" resolved from PATH), read at call time so tests
// and long-running processes pick up changes without re-importing the module.

const execFileAsync = promisify(execFile);

/** Default time budget for a single ffprobe invocation. */
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Upper bound for ffprobe's JSON output; well above any realistic file. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** Max stderr characters preserved on a ProbeError. */
const STDERR_EXCERPT_LENGTH = 500;

/**
 * Image codecs that only ever appear as embedded cover art in media
 * containers. A "video" stream with one of these codecs (or the attached_pic
 * disposition) does not make a file a video file.
 */
const COVER_ART_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif', 'tiff', 'webp']);

interface ProbeStreamBase {
  /** ffprobe stream index within the container. */
  index: number;
  codec: string | undefined;
  /** Lowercase ISO 639 language code, or undefined when absent/und. */
  language: string | undefined;
  /** Human-readable stream title tag, if any. */
  title: string | undefined;
  isDefault: boolean;
  isForced: boolean;
}

export interface ProbeVideoStream extends ProbeStreamBase {
  type: 'video';
  width: number | undefined;
  height: number | undefined;
  /** True for embedded cover art ("attached picture") streams. */
  isAttachedPic: boolean;
}

export interface ProbeAudioStream extends ProbeStreamBase {
  type: 'audio';
  channels: number | undefined;
  channelLayout: string | undefined;
}

export interface ProbeSubtitleStream extends ProbeStreamBase {
  type: 'subtitle';
}

export type ProbeStream = ProbeVideoStream | ProbeAudioStream | ProbeSubtitleStream;

export interface ProbeResult {
  /** Container format name as reported by ffprobe (e.g. "matroska,webm"). */
  container: string;
  durationMs: number | undefined;
  /** Overall bitrate in bits per second. */
  bitrate: number | undefined;
  sizeBytes: number | undefined;
  /** Video/audio/subtitle streams; data and attachment streams are dropped. */
  streams: ProbeStream[];
}

export type ProbeErrorKind =
  /** The input file does not exist (or is not accessible). */
  | 'file-missing'
  /** The ffprobe binary itself could not be found/spawned. */
  | 'ffprobe-not-found'
  /** ffprobe exited nonzero — corrupt file or not a media file. */
  | 'ffprobe-failed'
  /** ffprobe exceeded the time budget and was killed. */
  | 'timeout'
  /** ffprobe succeeded but produced output we could not understand. */
  | 'invalid-output';

/** Typed failure raised by probeFile — it never rejects with anything else. */
export class ProbeError extends Error {
  readonly kind: ProbeErrorKind;
  /** The probed file path. */
  readonly filePath: string;
  /** Trailing excerpt of ffprobe's stderr, when there was any. */
  readonly stderr: string | undefined;
  readonly exitCode: number | undefined;

  constructor(
    kind: ProbeErrorKind,
    filePath: string,
    message: string,
    details: { stderr?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ProbeError';
    this.kind = kind;
    this.filePath = filePath;
    this.stderr = details.stderr;
    this.exitCode = details.exitCode;
  }
}

export interface ProbeOptions {
  /** Overrides the FFPROBE_PATH env var / "ffprobe" default. */
  ffprobePath?: string;
  /** Overrides DEFAULT_PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Raw ffprobe JSON schema (only the fields we consume; the rest is ignored).
// ---------------------------------------------------------------------------

// Tag values are normally strings, but tolerate numbers rather than failing
// the whole probe over an odd tag.
const rawTagsSchema = z.record(z.string(), z.union([z.string(), z.number()]));

const rawStreamSchema = z.object({
  index: z.number().int().nonnegative(),
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  channel_layout: z.string().optional(),
  tags: rawTagsSchema.optional(),
  disposition: z.record(z.string(), z.number()).optional(),
});

const rawProbeOutputSchema = z.object({
  format: z.object({
    format_name: z.string(),
    duration: z.string().optional(),
    bit_rate: z.string().optional(),
    size: z.string().optional(),
  }),
  streams: z.array(rawStreamSchema).default([]),
});

type RawStream = z.infer<typeof rawStreamSchema>;

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** Case-insensitive tag lookup (Matroska reports e.g. ENCODER uppercase). */
function tagValue(tags: RawStream['tags'], name: string): string | undefined {
  if (tags === undefined) return undefined;
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === name) {
      const text = String(value).trim();
      return text.length > 0 ? text : undefined;
    }
  }
  return undefined;
}

/**
 * Normalises a language tag to a lowercase ISO 639 code ("eng", "en").
 * Returns undefined for missing, empty, undetermined ("und") or unparseable
 * values. Region subtags ("en-US") are stripped to the primary code.
 */
function normaliseLanguage(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const primary = raw.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary) || primary === 'und') return undefined;
  return primary;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function durationToMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

function mapStream(raw: RawStream): ProbeStream | undefined {
  const type = raw.codec_type;
  // Data and attachment streams (chapters, fonts, ...) are irrelevant to
  // playback decisions and are intentionally dropped.
  if (type !== 'video' && type !== 'audio' && type !== 'subtitle') return undefined;

  const base: ProbeStreamBase = {
    index: raw.index,
    codec: raw.codec_name,
    language: normaliseLanguage(tagValue(raw.tags, 'language')),
    title: tagValue(raw.tags, 'title'),
    isDefault: raw.disposition?.['default'] === 1,
    isForced: raw.disposition?.['forced'] === 1,
  };

  switch (type) {
    case 'video':
      return {
        ...base,
        type,
        width: raw.width,
        height: raw.height,
        isAttachedPic: raw.disposition?.['attached_pic'] === 1,
      };
    case 'audio':
      return { ...base, type, channels: raw.channels, channelLayout: raw.channel_layout };
    case 'subtitle':
      return { ...base, type };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs ffprobe against `absPath` and returns the parsed stream/container
 * information. Rejects with a ProbeError (never a raw error) whose `kind`
 * distinguishes a missing file, a missing ffprobe binary, a corrupt/non-media
 * file, a timeout, and unparseable ffprobe output.
 */
export async function probeFile(absPath: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  try {
    await access(absPath);
  } catch (cause) {
    throw new ProbeError('file-missing', absPath, `File not found or not readable: ${absPath}`, {
      cause,
    });
  }

  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobePath, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_STDOUT_BYTES,
    }));
  } catch (cause) {
    throw execErrorToProbeError(cause, absPath, ffprobePath, timeoutMs);
  }

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (cause) {
    throw new ProbeError('invalid-output', absPath, 'ffprobe produced non-JSON output', { cause });
  }

  const parsed = rawProbeOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProbeError(
      'invalid-output',
      absPath,
      `ffprobe output had an unexpected shape: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }

  const { format, streams } = parsed.data;
  return {
    container: format.format_name,
    durationMs: durationToMs(format.duration),
    bitrate: parsePositiveInt(format.bit_rate),
    sizeBytes: parsePositiveInt(format.size),
    streams: streams.map(mapStream).filter((stream) => stream !== undefined),
  };
}

function execErrorToProbeError(
  cause: unknown,
  filePath: string,
  ffprobePath: string,
  timeoutMs: number,
): ProbeError {
  const err = cause as Partial<{
    code: string | number;
    killed: boolean;
    signal: NodeJS.Signals;
    stderr: string;
  }>;
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
  const excerpt = stderr.length > 0 ? stderr.slice(-STDERR_EXCERPT_LENGTH) : undefined;

  if (err.code === 'ENOENT') {
    return new ProbeError(
      'ffprobe-not-found',
      filePath,
      `ffprobe binary not found at "${ffprobePath}" — install ffmpeg or set FFPROBE_PATH`,
      { cause },
    );
  }
  if (err.killed === true || err.signal === 'SIGKILL') {
    return new ProbeError(
      'timeout',
      filePath,
      `ffprobe timed out after ${timeoutMs}ms probing ${filePath}`,
      { cause, stderr: excerpt },
    );
  }
  const exitCode = typeof err.code === 'number' ? err.code : undefined;
  return new ProbeError(
    'ffprobe-failed',
    filePath,
    `ffprobe exited with code ${exitCode ?? 'unknown'} for ${filePath}` +
      (excerpt !== undefined ? `: ${excerpt}` : ''),
    { cause, stderr: excerpt, exitCode },
  );
}

/**
 * The file's video streams that are actual video — not embedded cover art
 * (attached_pic disposition or an image codec such as mjpeg/png).
 */
export function realVideoStreams(probe: ProbeResult): ProbeVideoStream[] {
  return probe.streams.filter(
    (stream): stream is ProbeVideoStream =>
      stream.type === 'video' && !stream.isAttachedPic && !COVER_ART_CODECS.has(stream.codec ?? ''),
  );
}

/** True when the probed file has at least one real (non cover art) video stream. */
export function isVideoFile(probe: ProbeResult): boolean {
  return realVideoStreams(probe).length > 0;
}
