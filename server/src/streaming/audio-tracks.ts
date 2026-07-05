import { languageLabel } from './subtitles.js';

// Audio track listing & labelling (pure — no DB, no ffmpeg, no I/O).
//
// A media file's audio tracks come from its persisted MediaStream rows (probed
// once by ffprobe at scan time). This module turns those rows into a stable,
// serialisable list the player consumes for its audio-track menu, and — most
// importantly — assigns each track its AUDIO-RELATIVE index (0..n among audio
// streams, in container order). That audio-relative index is exactly what the
// HLS transcoder maps with `-map 0:a:<index>`, so the number the player sends
// back to select a track lines up with ffmpeg's own stream ordering.
//
// It carries no filesystem path and does not spawn anything, so it is safe to
// call on the request path and is exhaustively unit-testable.

/** A persisted audio stream (a MediaStream row of type 'audio'). */
export interface AudioStreamRow {
  /** Absolute container stream index (MediaStream.streamIndex). */
  streamIndex: number;
  codec: string | null | undefined;
  language: string | null | undefined;
  title: string | null | undefined;
  /** Channel count (2 = stereo, 6 = 5.1, ...), when known. */
  channels: number | null | undefined;
  /** The container's default-audio disposition. */
  default: boolean;
}

/**
 * A public, serialisable descriptor of one audio track. This is exactly what
 * the list route returns — it deliberately carries no filesystem path.
 */
export interface AudioTrack {
  /**
   * 0-based AUDIO-RELATIVE index (its position among the file's audio streams,
   * in container order). This is the value used both for `-map 0:a:<index>`
   * and as the `audioTrack` selection a client sends back.
   */
  index: number;
  /** Raw codec name as ffprobe reported it (e.g. 'aac', 'ac3'), or undefined. */
  codec: string | undefined;
  /** Channel count, when known. */
  channels: number | undefined;
  /** Friendly channel layout derived from the channel count ('Stereo', '5.1'). */
  channelLayout: string | undefined;
  /** Lowercase ISO 639 language code, or undefined when unknown. */
  language: string | undefined;
  /** Stream title tag, or undefined. */
  title: string | undefined;
  /** Whether this is the container's default audio track. */
  default: boolean;
  /** Human-readable label for a track menu, e.g. "English 5.1 (AC3)". */
  label: string;
}

/**
 * Maps a channel count to a friendly layout name. Covers the common layouts;
 * an unusual count falls back to "<n>ch". Undefined/zero yields undefined.
 */
export function channelLayoutLabel(channels: number | null | undefined): string | undefined {
  if (channels === null || channels === undefined || channels <= 0) return undefined;
  switch (channels) {
    case 1:
      return 'Mono';
    case 2:
      return 'Stereo';
    case 6:
      return '5.1';
    case 7:
      return '6.1';
    case 8:
      return '7.1';
    default:
      return `${channels}ch`;
  }
}

/** Uppercased codec display token (e.g. 'ac3' -> 'AC3'), or undefined. */
function codecLabel(codec: string | null | undefined): string | undefined {
  const raw = (codec ?? '').trim();
  return raw.length > 0 ? raw.toUpperCase() : undefined;
}

/** Normalises a persisted language value to a code, or undefined when absent. */
function normaliseLanguage(raw: string | null | undefined): string | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  return value.length > 0 && value !== 'und' ? value : undefined;
}

/** Builds a human-readable track label from language, channels, codec & title. */
function buildLabel(params: {
  index: number;
  language: string | undefined;
  channels: number | undefined;
  codec: string | undefined;
  title: string | undefined;
}): string {
  const languageName = languageLabel(params.language);
  const layout = channelLayoutLabel(params.channels);
  const core = languageName ?? params.title ?? `Audio ${params.index + 1}`;
  const parts = [core];
  if (layout !== undefined) parts.push(layout);
  let label = parts.join(' ');
  const codec = codecLabel(params.codec);
  if (codec !== undefined) label += ` (${codec})`;
  return label;
}

/**
 * Lists a media file's audio tracks from its persisted audio MediaStream rows.
 * Streams are sorted by container index so each track's audio-relative index
 * (`0:a:n`) matches ffmpeg's own ordering exactly.
 */
export function listAudioTracks(streams: readonly AudioStreamRow[]): AudioTrack[] {
  const ordered = [...streams].sort((a, b) => a.streamIndex - b.streamIndex);
  return ordered.map((stream, index) => {
    const language = normaliseLanguage(stream.language);
    const channels = stream.channels ?? undefined;
    const codec = (stream.codec ?? '').trim().length > 0 ? (stream.codec ?? undefined) : undefined;
    const title = (stream.title ?? '').trim().length > 0 ? (stream.title ?? undefined) : undefined;
    return {
      index,
      codec: codec ?? undefined,
      channels,
      channelLayout: channelLayoutLabel(channels),
      language,
      title: title ?? undefined,
      default: stream.default,
      label: buildLabel({ index, language, channels, codec: codec ?? undefined, title: title ?? undefined }),
    } satisfies AudioTrack;
  });
}

/**
 * Resolves a client's requested audio-relative index to a valid one. A request
 * that is a non-negative integer within range is honoured; anything omitted or
 * out of range falls back to the container's default audio track (the first
 * track flagged default), or the first track (index 0) when none is flagged.
 * Returns 0 for a file with no audio tracks (the transcoder's optional `-map`
 * then simply maps nothing).
 */
export function resolveAudioTrackIndex(
  tracks: readonly AudioTrack[],
  requested: number | undefined,
): number {
  if (
    requested !== undefined &&
    Number.isInteger(requested) &&
    requested >= 0 &&
    requested < tracks.length
  ) {
    return requested;
  }
  const defaultIndex = tracks.findIndex((track) => track.default);
  return defaultIndex >= 0 ? defaultIndex : 0;
}
