import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { API_BASE, apiRequest } from './client';

// Data layer for the video player over the server's streaming contracts
// (server routes/stream.ts + subtitles.ts + qualities.ts + watch.ts). It owns
// the client-capability probe, the playback-decision call, the HLS session
// lifecycle (start/stop), the quality / audio / subtitle track listings, the
// throttled progress report and the token-carrying stream-URL builders. The
// pre-playback calls (decide, qualities, progress, item state) are JWT-authed
// and go through apiRequest; the media endpoints (hls start/stop, audio and
// subtitle listings) are authenticated by the short-lived `?token=` streaming
// token minted by /decide, so they skip the JWT silent-refresh dance.

// ---- DTOs (mirror the server streaming contracts) ---------------------------

/** What the client declares it can direct-play (POST /stream/decide body). */
export interface ClientCapabilities {
  containers?: string[];
  videoCodecs?: string[];
  audioCodecs?: string[];
  maxWidth?: number;
  maxHeight?: number;
  maxBitrate?: number;
}

/** Direct-play decision: the original bytes served from `url` (token in query). */
export interface DirectDecision {
  action: 'direct';
  reasons: string[];
  streamToken: string;
  expiresAt: string;
  /** `/api/stream/direct/:mediaFileId?token=…` — ready for the `<video>` src. */
  url: string;
}

/** Transcode decision: start an HLS session, first rung chosen by the server. */
export interface TranscodeDecision {
  action: 'transcode';
  reasons: string[];
  transcodeReason?: string;
  transcodeReasons?: string[];
  /** The ladder rung the server picked (clamped to the user's cap). */
  quality: string;
  streamToken: string;
  expiresAt: string;
  /** `/api/stream/hls/:mediaFileId?token=…&quality=…` — the HLS start endpoint. */
  hlsStartUrl: string;
}

export type PlaybackDecision = DirectDecision | TranscodeDecision;

/** The started HLS session (POST /stream/hls/:mediaFileId response). */
export interface HlsSession {
  sessionId: string;
  /** `/api/stream/hls/:sessionId/index.m3u8?token=…` — the playlist to load. */
  playlistUrl: string;
  quality: string;
  audioTrackIndex: number;
  downmixStereo: boolean;
  /** GRANTED seek offset (source seconds): the playlist starts at t=0 == here. */
  startOffsetSec: number;
}

/** One selectable quality rung (GET /api/qualities). */
export interface QualityRung {
  name: string;
  maxWidth: number;
  videoBitrate: string;
  audioBitrate: string;
}

/** GET /api/qualities — the rungs the current user may select. */
export interface QualitiesResponse {
  maxQuality: string;
  defaultQuality: string;
  qualities: QualityRung[];
}

/** One audio track (GET /stream/audio/:mediaFileId). */
export interface PlayerAudioTrack {
  index: number;
  codec?: string;
  channels?: number;
  channelLayout?: string;
  language?: string;
  title?: string;
  default: boolean;
  label: string;
}

export type SubtitleKind = 'text' | 'image';

/** One subtitle track (GET /stream/subtitles/:mediaFileId). */
export interface PlayerSubtitleTrack {
  id: string;
  source: 'embedded' | 'external';
  /** 'text' → serveable as WebVTT; 'image' → burn-in only (shown disabled). */
  kind: SubtitleKind;
  format: string;
  codec?: string;
  language?: string;
  title?: string;
  forced: boolean;
  default: boolean;
  label: string;
}

// ---- Capability probe -------------------------------------------------------

/** One MediaSource probe mapping a MIME/codecs string to what it proves. */
interface CapabilityProbe {
  type: string;
  container?: string;
  video?: string;
  audio?: string;
}

const CAPABILITY_PROBES: readonly CapabilityProbe[] = [
  { type: 'video/mp4; codecs="avc1.42E01E"', container: 'mp4', video: 'h264' },
  { type: 'video/mp4; codecs="avc1.640028"', container: 'mp4', video: 'h264' },
  { type: 'video/mp4; codecs="hev1.1.6.L93.B0"', container: 'mp4', video: 'hevc' },
  { type: 'video/mp4; codecs="av01.0.05M.08"', container: 'mp4', video: 'av1' },
  { type: 'video/mp4; codecs="mp4a.40.2"', container: 'mp4', audio: 'aac' },
  { type: 'video/mp4; codecs="ac-3"', audio: 'ac3' },
  { type: 'video/mp4; codecs="ec-3"', audio: 'eac3' },
  { type: 'video/mp4; codecs="mp3"', audio: 'mp3' },
  { type: 'audio/mp4; codecs="flac"', audio: 'flac' },
  { type: 'video/webm; codecs="vp8"', container: 'webm', video: 'vp8' },
  { type: 'video/webm; codecs="vp9"', container: 'webm', video: 'vp9' },
  { type: 'video/webm; codecs="av01.0.05M.08"', container: 'webm', video: 'av1' },
  { type: 'video/webm; codecs="opus"', container: 'webm', audio: 'opus' },
  { type: 'video/webm; codecs="vorbis"', container: 'webm', audio: 'vorbis' },
];

/**
 * Feature-detects what this browser can direct-play by asking
 * MediaSource.isTypeSupported for a spread of container/codec combinations, and
 * returns the shape POST /stream/decide expects. When MediaSource is
 * unavailable (e.g. jsdom, or an older browser using native HLS) it returns an
 * empty object so the server falls back to its conservative h264/aac browser
 * profile rather than "plays nothing".
 */
export function detectClientCapabilities(): ClientCapabilities {
  const MediaSourceCtor: typeof MediaSource | undefined =
    typeof MediaSource !== 'undefined' ? MediaSource : undefined;
  if (MediaSourceCtor === undefined || typeof MediaSourceCtor.isTypeSupported !== 'function') {
    return {};
  }
  const isSupported = (type: string): boolean => {
    try {
      return MediaSourceCtor.isTypeSupported(type);
    } catch {
      return false;
    }
  };

  const containers = new Set<string>();
  const videoCodecs = new Set<string>();
  const audioCodecs = new Set<string>();
  for (const probe of CAPABILITY_PROBES) {
    if (!isSupported(probe.type)) continue;
    if (probe.container !== undefined) containers.add(probe.container);
    if (probe.video !== undefined) videoCodecs.add(probe.video);
    if (probe.audio !== undefined) audioCodecs.add(probe.audio);
  }

  const caps: ClientCapabilities = {};
  if (containers.size > 0) caps.containers = [...containers];
  if (videoCodecs.size > 0) caps.videoCodecs = [...videoCodecs];
  if (audioCodecs.size > 0) caps.audioCodecs = [...audioCodecs];
  return caps;
}

// ---- Stream-URL builders ----------------------------------------------------

/** Serialises the `?token=` query for a media endpoint. */
function tokenQuery(token: string): string {
  return `?token=${encodeURIComponent(token)}`;
}

/**
 * The WebVTT URL for one text subtitle track, carrying the streaming token so a
 * plain `<track src>` (which cannot send a Bearer header) authenticates.
 */
export function subtitleVttUrl(mediaFileId: string, trackId: string, token: string): string {
  return `${API_BASE}/stream/subtitles/${encodeURIComponent(mediaFileId)}/${encodeURIComponent(
    trackId,
  )}.vtt${tokenQuery(token)}`;
}

/** Options for (re)starting an HLS transcode session. */
export interface HlsStartOptions {
  quality?: string;
  audioTrack?: number;
  downmixStereo?: boolean;
  /** Source seconds to begin the transcode at (transcode-seek). */
  startOffset?: number;
}

/** POST /stream/hls/:mediaFileId — starts (or reuses) a transcode session. */
function hlsStartPath(mediaFileId: string, token: string, options: HlsStartOptions): string {
  const params = new URLSearchParams();
  params.set('token', token);
  if (options.quality !== undefined) params.set('quality', options.quality);
  if (options.audioTrack !== undefined) params.set('audioTrack', String(options.audioTrack));
  if (options.downmixStereo !== undefined) {
    params.set('downmixStereo', String(options.downmixStereo));
  }
  if (options.startOffset !== undefined) {
    params.set('startOffset', String(Math.max(0, Math.floor(options.startOffset))));
  }
  return `/stream/hls/${encodeURIComponent(mediaFileId)}?${params.toString()}`;
}

// ---- Requests ---------------------------------------------------------------

/** POST /api/stream/decide/:mediaFileId — direct-vs-transcode + token + URLs. */
export function decidePlayback(
  mediaFileId: string,
  capabilities: ClientCapabilities,
): Promise<PlaybackDecision> {
  return apiRequest<PlaybackDecision>(`/stream/decide/${encodeURIComponent(mediaFileId)}`, {
    method: 'POST',
    body: capabilities,
  });
}

/** POST /api/stream/hls/:mediaFileId — start/restart a transcode session. */
export function startHlsSession(
  mediaFileId: string,
  token: string,
  options: HlsStartOptions = {},
): Promise<HlsSession> {
  return apiRequest<HlsSession>(hlsStartPath(mediaFileId, token, options), {
    method: 'POST',
    skipAuthRefresh: true,
  });
}

/** DELETE /api/stream/hls/:sessionId — free the transcode slot. Idempotent. */
export function stopHlsSession(sessionId: string, token: string): Promise<void> {
  return apiRequest<void>(`/stream/hls/${encodeURIComponent(sessionId)}${tokenQuery(token)}`, {
    method: 'DELETE',
    skipAuthRefresh: true,
  });
}

/** GET /api/qualities — the rungs the current user may select. */
export function getQualities(): Promise<QualitiesResponse> {
  return apiRequest<QualitiesResponse>('/qualities');
}

/** GET /api/stream/audio/:mediaFileId — the file's selectable audio tracks. */
export async function getAudioTracks(
  mediaFileId: string,
  token: string,
): Promise<PlayerAudioTrack[]> {
  const data = await apiRequest<{ mediaFileId: string; tracks: PlayerAudioTrack[] }>(
    `/stream/audio/${encodeURIComponent(mediaFileId)}${tokenQuery(token)}`,
    { skipAuthRefresh: true },
  );
  return data.tracks;
}

/** GET /api/stream/subtitles/:mediaFileId — the file's subtitle tracks. */
export async function getSubtitleTracks(
  mediaFileId: string,
  token: string,
): Promise<PlayerSubtitleTrack[]> {
  const data = await apiRequest<{ mediaFileId: string; tracks: PlayerSubtitleTrack[] }>(
    `/stream/subtitles/${encodeURIComponent(mediaFileId)}${tokenQuery(token)}`,
    { skipAuthRefresh: true },
  );
  return data.tracks;
}

/** POST /api/items/:id/progress — report playback position (best-effort). */
export function reportProgress(
  itemId: string,
  positionMs: number,
  durationMs?: number,
): Promise<unknown> {
  const body: { positionMs: number; durationMs?: number } = {
    positionMs: Math.max(0, Math.round(positionMs)),
  };
  if (durationMs !== undefined && durationMs > 0) body.durationMs = Math.round(durationMs);
  return apiRequest(`/items/${encodeURIComponent(itemId)}/progress`, { method: 'POST', body });
}

// ---- Query keys -------------------------------------------------------------

export const playerKeys = {
  decision: (mediaFileId: string) => ['player', 'decision', mediaFileId] as const,
  qualities: ['player', 'qualities'] as const,
  audio: (mediaFileId: string) => ['player', 'audio', mediaFileId] as const,
  subtitles: (mediaFileId: string) => ['player', 'subtitles', mediaFileId] as const,
};

// ---- Hooks ------------------------------------------------------------------

/**
 * The playback decision for a media file. Runs once per file (never retried on
 * an auth/permission failure — a 401/404 is surfaced so the page can show an
 * error and a link back), and never refetched in the background so the minted
 * stream token stays stable for the whole session.
 */
export function usePlaybackDecision(
  mediaFileId: string,
  capabilities: ClientCapabilities,
): UseQueryResult<PlaybackDecision> {
  return useQuery({
    queryKey: playerKeys.decision(mediaFileId),
    queryFn: () => decidePlayback(mediaFileId, capabilities),
    enabled: mediaFileId !== '',
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** GET /api/qualities as a query for the quality menu. */
export function useQualities(): UseQueryResult<QualitiesResponse> {
  return useQuery({
    queryKey: playerKeys.qualities,
    queryFn: getQualities,
    staleTime: 5 * 60_000,
  });
}
