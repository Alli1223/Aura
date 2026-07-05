import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveMediaFileForServing } from '../lib/media-roots.js';

// Subtitle discovery, classification and WebVTT conversion.
//
// A video's subtitle tracks come from two places:
//   (a) EMBEDDED streams muxed into the container (already probed by ffprobe
//       and persisted as MediaStream rows), and
//   (b) EXTERNAL sidecar files sitting next to the video on disk
//       (`Movie.en.srt`, `Movie.eng.forced.srt`, `Movie.vtt`, ...).
//
// This module merges both into a single, stably-identified list, classifies
// each as TEXT (web-serveable as WebVTT) or IMAGE (PGS/VobSub/DVD/DVB — cannot
// be turned into text; the player must request a burn-in transcode, a FUTURE
// roadmap item: `subtitle-burn-in`), and converts text tracks to a WebVTT
// string the web player consumes via a <track> element.
//
// SECURITY (see CLAUDE.md):
//  - ffmpeg is ALWAYS spawned with an argument array, never a shell string.
//  - Every filesystem path is validated to live inside a configured media root
//    (resolveMediaFileForServing) before it is read; external discovery only
//    ever reads the video's own directory and rejects sidecars that resolve
//    (via symlink) outside the roots.
//  - Track ids follow a strict, server-generated scheme and are validated
//    against a pattern before ever being used to build a cache path, so a
//    trackId can never traverse out of the cache directory.

const execFileAsync = promisify(execFile);

/** Default time budget for a single ffmpeg subtitle conversion. */
export const DEFAULT_SUBTITLE_TIMEOUT_MS = 30_000;

/**
 * Upper bound on a converted/served WebVTT payload. Subtitle tracks are tiny
 * (a feature film's SRT is well under a megabyte); anything larger is treated
 * as a conversion failure rather than streamed.
 */
export const MAX_VTT_BYTES = 5 * 1024 * 1024;

/** Sidecar file extensions recognised as external subtitles. */
const EXTERNAL_FORMATS = {
  '.srt': 'srt',
  '.ass': 'ass',
  '.ssa': 'ssa',
  '.vtt': 'vtt',
  '.sub': 'sub',
} as const;

/** An external sidecar's file format. */
export type ExternalSubtitleFormat = (typeof EXTERNAL_FORMATS)[keyof typeof EXTERNAL_FORMATS];

/**
 * Subtitle codecs that are image (bitmap) based. These cannot be converted to
 * text/WebVTT — they can only be shown by burning them into the video stream
 * (the `subtitle-burn-in` roadmap item). Values are the codec names ffprobe
 * reports plus their common aliases.
 */
const IMAGE_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'pgssub',
  'pgs',
  'dvd_subtitle',
  'dvdsub',
  'vobsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub',
]);

/** Whether a subtitle track is text (WebVTT-serveable) or image (burn-in only). */
export type SubtitleKind = 'text' | 'image';

/** Where a subtitle track came from. */
export type SubtitleSource = 'embedded' | 'external';

/**
 * A public, serialisable descriptor of one subtitle track. This is exactly
 * what the list route returns — it deliberately carries no filesystem path.
 */
export interface SubtitleTrack {
  /**
   * Stable, path-safe id. `embedded-<streamIndex>` for a muxed stream,
   * `external-<hash>` for a sidecar file (hash of its filename). Used both in
   * the .vtt URL and as the cache filename.
   */
  id: string;
  source: SubtitleSource;
  kind: SubtitleKind;
  /** Normalised, lowercase format/codec label (e.g. 'srt', 'ass', 'pgs'). */
  format: string;
  /** Raw codec name (embedded) or sidecar extension format (external). */
  codec: string | undefined;
  /** Lowercase ISO 639 language code, or undefined when unknown. */
  language: string | undefined;
  /** Stream/file title tag, or undefined. */
  title: string | undefined;
  forced: boolean;
  default: boolean;
  /** Human-readable label for a track menu (language name, title and flags). */
  label: string;
}

/** Internal track carrying the fields needed to actually extract the VTT. */
interface ResolvedSubtitleTrack extends SubtitleTrack {
  /** Embedded only: 0-based index among subtitle streams (for `-map 0:s:n`). */
  subtitleIndex?: number;
  /** External only: absolute sidecar path (never serialised to clients). */
  sidecarPath?: string;
  /** External only: the sidecar's file format. */
  externalFormat?: ExternalSubtitleFormat;
}

/** A persisted embedded subtitle stream (a MediaStream row of type 'subtitle'). */
export interface EmbeddedSubtitleStream {
  /** Absolute container stream index (MediaStream.streamIndex). */
  streamIndex: number;
  codec: string | null | undefined;
  language: string | null | undefined;
  title: string | null | undefined;
  forced: boolean;
  default: boolean;
}

/** The media file whose subtitles are being listed/extracted. */
export interface SubtitleMediaFile {
  /** MediaFile id (used only to scope the cache directory). */
  id: string;
  /** Absolute path to the video file, as stored on the MediaFile row. */
  path: string;
  /** The file's persisted embedded subtitle streams. */
  subtitleStreams: readonly EmbeddedSubtitleStream[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a trackId matches no known track (or is malformed). => 404. */
export class SubtitleNotFoundError extends Error {
  readonly trackId: string;
  constructor(trackId: string) {
    super(`No subtitle track with id "${trackId}"`);
    this.name = 'SubtitleNotFoundError';
    this.trackId = trackId;
  }
}

/**
 * Thrown when a caller asks to convert an IMAGE-based subtitle track to text.
 * Image subs can only be burned into the video (a future item); the route maps
 * this to a typed 4xx, never a 500.
 */
export class ImageSubtitleError extends Error {
  readonly trackId: string;
  readonly codec: string | undefined;
  constructor(trackId: string, codec: string | undefined) {
    super(
      `Subtitle track "${trackId}" is image-based (${codec ?? 'unknown'}) and cannot be ` +
        'converted to WebVTT; it requires a burn-in transcode',
    );
    this.name = 'ImageSubtitleError';
    this.trackId = trackId;
    this.codec = codec;
  }
}

/** Thrown when ffmpeg fails to convert a text track, or output is not valid VTT. */
export class SubtitleConversionError extends Error {
  readonly trackId: string;
  readonly stderr: string | undefined;
  constructor(trackId: string, message: string, stderr?: string) {
    super(message);
    this.name = 'SubtitleConversionError';
    this.trackId = trackId;
    this.stderr = stderr === undefined || stderr.length === 0 ? undefined : stderr;
  }
}

// ---------------------------------------------------------------------------
// Classification & labelling helpers (pure)
// ---------------------------------------------------------------------------

/** Classifies a subtitle codec as text (WebVTT-able) or image (burn-in only). */
export function classifySubtitleKind(codec: string | null | undefined): SubtitleKind {
  if (codec === null || codec === undefined) return 'text';
  return IMAGE_SUBTITLE_CODECS.has(codec.trim().toLowerCase()) ? 'image' : 'text';
}

/** Maps a raw codec/extension to a short, friendly, lowercase format label. */
function normaliseFormat(codec: string | null | undefined): string {
  const raw = (codec ?? '').trim().toLowerCase();
  switch (raw) {
    case 'subrip':
    case 'srt':
    case 'mov_text':
      return 'srt';
    case 'ass':
      return 'ass';
    case 'ssa':
      return 'ssa';
    case 'webvtt':
    case 'vtt':
      return 'vtt';
    case 'hdmv_pgs_subtitle':
    case 'pgssub':
    case 'pgs':
      return 'pgs';
    case 'dvd_subtitle':
    case 'dvdsub':
    case 'vobsub':
      return 'vobsub';
    case 'dvb_subtitle':
    case 'dvbsub':
      return 'dvbsub';
    default:
      return raw.length > 0 ? raw : 'unknown';
  }
}

/** Common ISO 639 language codes (2- and 3-letter) → English display name. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  eng: 'English',
  es: 'Spanish',
  spa: 'Spanish',
  fr: 'French',
  fra: 'French',
  fre: 'French',
  de: 'German',
  deu: 'German',
  ger: 'German',
  it: 'Italian',
  ita: 'Italian',
  pt: 'Portuguese',
  por: 'Portuguese',
  ru: 'Russian',
  rus: 'Russian',
  ja: 'Japanese',
  jpn: 'Japanese',
  zh: 'Chinese',
  zho: 'Chinese',
  chi: 'Chinese',
  ko: 'Korean',
  kor: 'Korean',
  ar: 'Arabic',
  ara: 'Arabic',
  hi: 'Hindi',
  hin: 'Hindi',
  nl: 'Dutch',
  nld: 'Dutch',
  dut: 'Dutch',
  sv: 'Swedish',
  swe: 'Swedish',
  no: 'Norwegian',
  nor: 'Norwegian',
  da: 'Danish',
  dan: 'Danish',
  fi: 'Finnish',
  fin: 'Finnish',
  pl: 'Polish',
  pol: 'Polish',
  tr: 'Turkish',
  tur: 'Turkish',
  cs: 'Czech',
  ces: 'Czech',
  cze: 'Czech',
  el: 'Greek',
  ell: 'Greek',
  gre: 'Greek',
  he: 'Hebrew',
  heb: 'Hebrew',
  th: 'Thai',
  tha: 'Thai',
  uk: 'Ukrainian',
  ukr: 'Ukrainian',
  hu: 'Hungarian',
  hun: 'Hungarian',
  ro: 'Romanian',
  ron: 'Romanian',
  rum: 'Romanian',
  id: 'Indonesian',
  ind: 'Indonesian',
  vi: 'Vietnamese',
  vie: 'Vietnamese',
};

/** English display name for a language code, or the uppercased code as fallback. */
export function languageLabel(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

/** Builds a human-readable track label from language, title and flags. */
function buildLabel(params: {
  source: SubtitleSource;
  language: string | undefined;
  title: string | undefined;
  forced: boolean;
  kind: SubtitleKind;
}): string {
  const languageName = languageLabel(params.language);
  const core =
    params.title ?? languageName ?? (params.source === 'external' ? 'External' : 'Subtitles');
  const flags: string[] = [];
  if (params.forced) flags.push('Forced');
  if (params.kind === 'image') flags.push('Image');
  return flags.length > 0 ? `${core} (${flags.join(', ')})` : core;
}

// ---------------------------------------------------------------------------
// Language / filename parsing
// ---------------------------------------------------------------------------

/**
 * Normalises a language tag to a lowercase ISO 639 code. Mirrors the ffprobe
 * module's rule: primary subtag only, 2–3 letters, undefined for "und".
 */
function normaliseLanguage(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const primary = raw.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary) || primary === 'und') return undefined;
  return primary;
}

/** A tolerated "forced" flag token in a sidecar filename. */
const FORCED_TOKENS = new Set(['forced']);

interface ParsedSidecar {
  format: ExternalSubtitleFormat;
  language: string | undefined;
  forced: boolean;
  title: string | undefined;
}

/**
 * Parses a sidecar filename against a video's base name, extracting the
 * format, an optional language code and a forced flag. Returns undefined when
 * the file is not a subtitle sidecar for this video.
 *
 * The name must be `<videoBase>.<ext>` or `<videoBase>.<mods...>.<ext>` where
 * ext is a known subtitle extension and the dot-separated modifiers may carry
 * a language code (`en`, `eng`) and/or the token `forced` in any order:
 *   Movie.srt · Movie.en.srt · Movie.eng.forced.srt · Movie.forced.srt
 * Base and extension are matched case-insensitively.
 */
export function parseSidecarName(fileName: string, videoBase: string): ParsedSidecar | undefined {
  const ext = path.extname(fileName).toLowerCase();
  const format = (EXTERNAL_FORMATS as Record<string, ExternalSubtitleFormat | undefined>)[ext];
  if (format === undefined) return undefined;

  const stem = fileName.slice(0, fileName.length - ext.length);
  const base = videoBase.toLowerCase();
  const stemLower = stem.toLowerCase();

  let modifiers: string;
  if (stemLower === base) {
    modifiers = '';
  } else if (stemLower.startsWith(`${base}.`)) {
    modifiers = stem.slice(base.length + 1);
  } else {
    return undefined;
  }

  let language: string | undefined;
  let forced = false;
  const leftover: string[] = [];
  for (const token of modifiers.split('.').filter((t) => t.length > 0)) {
    if (FORCED_TOKENS.has(token.toLowerCase())) {
      forced = true;
      continue;
    }
    if (language === undefined) {
      const lang = normaliseLanguage(token);
      if (lang !== undefined) {
        language = lang;
        continue;
      }
    }
    leftover.push(token);
  }

  return {
    format,
    language,
    forced,
    title: leftover.length > 0 ? leftover.join('.') : undefined,
  };
}

/** The video basename without its final extension (`Movie (2020).mkv` → `Movie (2020)`). */
function videoBaseName(videoPath: string): string {
  const base = path.basename(videoPath);
  const ext = path.extname(base);
  return ext.length > 0 ? base.slice(0, base.length - ext.length) : base;
}

/** Short, stable, path-safe hash of a sidecar filename for its track id. */
function sidecarHash(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 16);
}

/** Strict track-id grammar. Anything else can never map to a real track. */
const TRACK_ID_PATTERN = /^(embedded-\d{1,9}|external-[0-9a-f]{16})$/;

/** Whether a string is a well-formed track id from this module's scheme. */
export function isValidTrackId(trackId: string): boolean {
  return TRACK_ID_PATTERN.test(trackId);
}

// ---------------------------------------------------------------------------
// Track resolution
// ---------------------------------------------------------------------------

function resolveEmbeddedTracks(
  streams: readonly EmbeddedSubtitleStream[],
): ResolvedSubtitleTrack[] {
  // Sort by container index so the subtitle-relative index (`0:s:n`) matches
  // ffmpeg's own ordering exactly.
  const ordered = [...streams].sort((a, b) => a.streamIndex - b.streamIndex);
  return ordered.map((stream, subtitleIndex) => {
    const kind = classifySubtitleKind(stream.codec);
    const language = normaliseLanguage(stream.language ?? undefined);
    const title = stream.title ?? undefined;
    return {
      id: `embedded-${stream.streamIndex}`,
      source: 'embedded',
      kind,
      format: normaliseFormat(stream.codec),
      codec: stream.codec ?? undefined,
      language,
      title,
      forced: stream.forced,
      default: stream.default,
      label: buildLabel({ source: 'embedded', language, title, forced: stream.forced, kind }),
      subtitleIndex,
    } satisfies ResolvedSubtitleTrack;
  });
}

/**
 * Discovers external sidecar subtitle files next to the video. Only ever reads
 * the video's own directory, and every candidate is re-validated to resolve to
 * a real file inside a configured media root (a decoy above the root, or a
 * symlink escaping it, is ignored).
 */
async function discoverExternalTracks(
  videoPath: string,
  mediaRoots: readonly string[],
): Promise<ResolvedSubtitleTrack[]> {
  const resolution = await resolveMediaFileForServing(videoPath, mediaRoots);
  if (!resolution.ok) return [];

  const canonicalVideo = resolution.canonicalPath;
  const dir = path.dirname(canonicalVideo);
  const videoBase = videoBaseName(canonicalVideo);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const tracks: ResolvedSubtitleTrack[] = [];
  for (const name of entries) {
    const parsed = parseSidecarName(name, videoBase);
    if (parsed === undefined) continue;

    // Re-validate the sidecar itself: it must resolve to a real file inside a
    // media root (rejects a symlink that escapes the roots).
    const sidecar = await resolveMediaFileForServing(path.join(dir, name), mediaRoots);
    if (!sidecar.ok) continue;

    // Every recognised sidecar format is text-based (even `.sub`, which ffmpeg
    // treats as MicroDVD text; a VobSub `.sub` would fail conversion later).
    const kind: SubtitleKind = 'text';
    tracks.push({
      id: `external-${sidecarHash(name)}`,
      source: 'external',
      kind,
      format: parsed.format,
      codec: parsed.format,
      language: parsed.language,
      title: parsed.title,
      forced: parsed.forced,
      default: false,
      label: buildLabel({
        source: 'external',
        language: parsed.language,
        title: parsed.title,
        forced: parsed.forced,
        kind,
      }),
      sidecarPath: sidecar.canonicalPath,
      externalFormat: parsed.format,
    });
  }

  // Deterministic order: language, then filename hash (embedded already sorted).
  tracks.sort(
    (a, b) => (a.language ?? '').localeCompare(b.language ?? '') || a.id.localeCompare(b.id),
  );
  return tracks;
}

async function resolveTracks(
  mediaFile: SubtitleMediaFile,
  mediaRoots: readonly string[],
): Promise<ResolvedSubtitleTrack[]> {
  const embedded = resolveEmbeddedTracks(mediaFile.subtitleStreams);
  const external = await discoverExternalTracks(mediaFile.path, mediaRoots);
  return [...embedded, ...external];
}

/** Strips the public subset from an internal track (drops filesystem paths). */
function toPublicTrack(track: ResolvedSubtitleTrack): SubtitleTrack {
  return {
    id: track.id,
    source: track.source,
    kind: track.kind,
    format: track.format,
    codec: track.codec,
    language: track.language,
    title: track.title,
    forced: track.forced,
    default: track.default,
    label: track.label,
  };
}

/**
 * Lists every subtitle track for a media file: its embedded streams (from the
 * persisted MediaStream rows) merged with any external sidecar files next to
 * the video, each classified text vs image. Never throws for filesystem
 * reasons — a missing video simply yields no external tracks.
 */
export async function listSubtitles(
  mediaFile: SubtitleMediaFile,
  options: { mediaRoots: readonly string[] },
): Promise<SubtitleTrack[]> {
  const tracks = await resolveTracks(mediaFile, options.mediaRoots);
  return tracks.map(toPublicTrack);
}

/**
 * The concrete information needed to BURN one subtitle track into a transcode,
 * resolved from a public trackId. Keeps the trackId scheme (and the sidecar
 * filesystem discovery) inside this module so the HLS transcoder never has to
 * know it: it receives a stream index for embedded tracks or a validated
 * sidecar path for external ones.
 */
export interface BurnSubtitleSource {
  /** Text (libass `subtitles` filter) vs image (bitmap `overlay`). */
  kind: SubtitleKind;
  source: SubtitleSource;
  /**
   * Embedded only: 0-based index among subtitle streams, for `[0:s:<n>]`
   * (image overlay) or the `subtitles` filter's `si=<n>` (text).
   */
  subtitleIndex?: number;
  /** External only: absolute sidecar path, validated inside a media root. */
  sidecarPath?: string;
}

/**
 * Resolves a subtitle `trackId` (as surfaced by listSubtitles) to the concrete
 * info needed to burn it into a transcode, validating it against the file's
 * REAL tracks. A malformed or unknown id throws SubtitleNotFoundError (the route
 * maps this to a 400/404). Every embedded track — text or image — resolves to
 * its subtitle-relative stream index; an external sidecar resolves to a
 * media-root-validated absolute path. Never converts anything (no ffmpeg run).
 */
export async function resolveBurnSubtitle(
  mediaFile: SubtitleMediaFile,
  trackId: string,
  options: { mediaRoots: readonly string[] },
): Promise<BurnSubtitleSource> {
  if (!isValidTrackId(trackId)) throw new SubtitleNotFoundError(trackId);
  const tracks = await resolveTracks(mediaFile, options.mediaRoots);
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) throw new SubtitleNotFoundError(trackId);
  return {
    kind: track.kind,
    source: track.source,
    subtitleIndex: track.subtitleIndex,
    sidecarPath: track.sidecarPath,
  };
}

// ---------------------------------------------------------------------------
// WebVTT extraction
// ---------------------------------------------------------------------------

/** Strips a leading UTF-8 BOM if present. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Whether a string carries a valid WebVTT signature. */
export function hasWebVttHeader(text: string): boolean {
  return stripBom(text).startsWith('WEBVTT');
}

/**
 * Runs ffmpeg to convert a subtitle input to a WebVTT string on stdout. The
 * default converter; injectable so tests can assert whether ffmpeg ran.
 */
export type WebVttConverter = (
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export const ffmpegWebVttConverter: WebVttConverter = async (ffmpegPath, args, timeoutMs) => {
  const { stdout } = await execFileAsync(ffmpegPath, [...args], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_VTT_BYTES,
    encoding: 'utf8',
  });
  return stdout;
};

export interface ExtractWebVttOptions {
  /** Configured media roots; the video and any sidecar must resolve inside one. */
  mediaRoots: readonly string[];
  /** Root scratch directory (settings.transcodeDir) for the VTT cache. */
  transcodeDir: string;
  /** ffmpeg binary. Defaults to FFMPEG_PATH env or "ffmpeg". */
  ffmpegPath?: string;
  /** Conversion time budget. Defaults to DEFAULT_SUBTITLE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Converter injection point (tests). Defaults to the real ffmpeg runner. */
  convert?: WebVttConverter;
  /** Whether to read/write the on-disk cache. Defaults to true. */
  useCache?: boolean;
}

/** The directory holding cached WebVTT files for one media file. */
function subtitleCacheDir(transcodeDir: string, mediaFileId: string): string {
  return path.join(transcodeDir, 'subtitles', mediaFileId);
}

/**
 * Resolves the cache path for a (mediaFileId, trackId), validating BOTH ids so
 * neither can traverse out of the cache root. Returns undefined for an invalid
 * id (the caller treats it as "no such track").
 */
function cacheVttPath(
  transcodeDir: string,
  mediaFileId: string,
  trackId: string,
): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(mediaFileId)) return undefined;
  if (!isValidTrackId(trackId)) return undefined;
  const dir = subtitleCacheDir(transcodeDir, mediaFileId);
  const filePath = path.join(dir, `${trackId}.vtt`);
  // Defence in depth: the resolved path must stay inside the cache dir.
  if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) return undefined;
  return filePath;
}

async function readCachedVtt(cachePath: string): Promise<string | undefined> {
  try {
    const data = await readFile(cachePath, 'utf8');
    return hasWebVttHeader(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Atomically writes VTT to the cache (temp file + rename). Best effort. */
async function writeCachedVtt(cachePath: string, vtt: string): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, vtt, 'utf8');
  await rename(tmp, cachePath);
}

/** Validates and size-caps a produced/loaded VTT string. */
function finaliseVtt(trackId: string, vtt: string): string {
  if (!hasWebVttHeader(vtt)) {
    throw new SubtitleConversionError(trackId, 'Converter did not produce a valid WebVTT document');
  }
  if (Buffer.byteLength(vtt, 'utf8') > MAX_VTT_BYTES) {
    throw new SubtitleConversionError(trackId, 'Converted WebVTT exceeds the maximum allowed size');
  }
  return vtt;
}

async function convertToVtt(
  trackId: string,
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number,
  convert: WebVttConverter,
): Promise<string> {
  let stdout: string;
  try {
    stdout = await convert(ffmpegPath, args, timeoutMs);
  } catch (cause) {
    const err = cause as Partial<{ stderr: string; message: string }>;
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim().slice(-500) : undefined;
    throw new SubtitleConversionError(
      trackId,
      `ffmpeg failed to convert subtitle track "${trackId}" to WebVTT`,
      stderr,
    );
  }
  return finaliseVtt(trackId, stdout);
}

/** Reads and validates an external `.vtt` sidecar for passthrough serving. */
async function passthroughVtt(trackId: string, sidecarPath: string): Promise<string> {
  let stats;
  try {
    stats = await stat(sidecarPath);
  } catch {
    throw new SubtitleNotFoundError(trackId);
  }
  if (stats.size > MAX_VTT_BYTES) {
    throw new SubtitleConversionError(trackId, 'External WebVTT exceeds the maximum allowed size');
  }
  const data = stripBom(await readFile(sidecarPath, 'utf8'));
  if (!hasWebVttHeader(data)) {
    throw new SubtitleConversionError(trackId, 'External .vtt file is missing its WEBVTT header');
  }
  return data;
}

/**
 * Extracts (or reuses a cached) WebVTT document for one text subtitle track.
 *
 * Resolution & failure modes:
 *  - malformed/unknown trackId → SubtitleNotFoundError (route → 404);
 *  - an image-based track       → ImageSubtitleError (route → typed 4xx);
 *  - ffmpeg failure / bad output→ SubtitleConversionError (route → 422).
 *
 * A successful result is cached under `<transcodeDir>/subtitles/<fileId>/<trackId>.vtt`
 * (atomic write) and reused on subsequent calls without re-running ffmpeg.
 */
export async function extractWebVtt(
  mediaFile: SubtitleMediaFile,
  trackId: string,
  options: ExtractWebVttOptions,
): Promise<string> {
  if (!isValidTrackId(trackId)) throw new SubtitleNotFoundError(trackId);

  const useCache = options.useCache ?? true;
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBTITLE_TIMEOUT_MS;
  const convert = options.convert ?? ffmpegWebVttConverter;

  const cachePath = cacheVttPath(options.transcodeDir, mediaFile.id, trackId);
  if (cachePath === undefined) throw new SubtitleNotFoundError(trackId);

  // Serve from cache before touching ffmpeg or the source files.
  if (useCache) {
    const cached = await readCachedVtt(cachePath);
    if (cached !== undefined) return cached;
  }

  const tracks = await resolveTracks(mediaFile, options.mediaRoots);
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) throw new SubtitleNotFoundError(trackId);
  if (track.kind === 'image') throw new ImageSubtitleError(trackId, track.codec);

  let vtt: string;
  if (track.source === 'external') {
    if (track.sidecarPath === undefined) throw new SubtitleNotFoundError(trackId);
    if (track.externalFormat === 'vtt') {
      vtt = await passthroughVtt(trackId, track.sidecarPath);
    } else {
      const args = ['-nostdin', '-loglevel', 'error', '-i', track.sidecarPath, '-f', 'webvtt', '-'];
      vtt = await convertToVtt(trackId, ffmpegPath, args, timeoutMs, convert);
    }
  } else {
    // Embedded: re-resolve the video path inside the media roots before ffmpeg.
    const resolution = await resolveMediaFileForServing(mediaFile.path, options.mediaRoots);
    if (!resolution.ok) throw new SubtitleNotFoundError(trackId);
    const args = [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      resolution.canonicalPath,
      '-map',
      `0:s:${track.subtitleIndex ?? 0}`,
      '-f',
      'webvtt',
      '-',
    ];
    vtt = await convertToVtt(trackId, ffmpegPath, args, timeoutMs, convert);
  }

  if (useCache) {
    try {
      await writeCachedVtt(cachePath, vtt);
    } catch {
      // A cache write failure must not fail the request; the VTT is still valid.
    }
  }
  return vtt;
}
