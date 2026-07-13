import { useQuery } from '@tanstack/react-query';
import Hls, { type ErrorData, type HlsConfig } from 'hls.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';

import { ApiError } from '../api/client';
import { useItemDetail, type ChapterInfo } from '../api/detail';
import { usePlaylist } from '../api/playlists';
import {
  detectClientCapabilities,
  getAudioTracks,
  getSubtitleTracks,
  playerKeys,
  reportProgress,
  startHlsSession,
  stopHlsSession,
  subtitleVttUrl,
  usePlaybackDecision,
  useQualities,
  type PlaybackDecision,
  type PlayerAudioTrack,
  type PlayerSubtitleTrack,
} from '../api/player';
import {
  PlayerControls,
  type QualityOption,
  type TrackOption,
} from '../components/player/PlayerControls';
import { formatTime } from '../components/player/format';
import { PlayGlyph, ReplayGlyph } from '../components/player/PlayerIcons';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../auth/context';
import { useTrickplayManifest } from '../api/trickplay';
import styles from './PlayerPage.module.css';

// The hls.js player page, reached at `/player/:mediaFileId?item=:itemId`.
//
// Flow: probe the browser's codec support → POST /stream/decide. A 'direct'
// decision points the <video> at the token-carrying file URL; a 'transcode'
// decision starts an HLS session and attaches hls.js to the growing playlist
// (falling back to native HLS on Safari when MSE is unavailable). Custom
// controls (play/seek/volume/fullscreen + quality/audio/subtitle menus) sit in
// PlayerControls; this file owns the imperative media engine that drives them.
//
// Quality and audio switches, and any seek past the transcoded/buffered window,
// RESTART the HLS session at the current source position (POST /stream/hls with
// startOffset) and re-attach — the new playlist starts at t=0 == that offset, so
// source time is always `session.startOffsetSec + video.currentTime`. Subtitles
// are WebVTT <track> overlays (independent of direct/transcode); image-based
// tracks are shown disabled because the browser cannot render them. Progress is
// reported (throttled) every ~10s and on pause/ended/unmount, and the HLS
// session is DELETEd on unmount to free the transcode slot.

const SEEK_STEP_SECONDS = 10;
const VOLUME_STEP = 0.1;
const CONTROLS_HIDE_MS = 3000;
const PROGRESS_INTERVAL_MS = 10_000;
const NEXT_EPISODE_COUNTDOWN_S = 10;
const IMAGE_SUB_REASON = 'Not supported in browser';

/**
 * A queued next item for autoplay. Episodes come in via navigation `state`; a
 * playlist queue additionally carries the playlist id + this item's index so the
 * next hop can rebuild a refresh-safe `?playlist=&index=` URL.
 */
interface PlayDescriptor {
  mediaFileId: string;
  itemId: string;
  title: string;
  /** Playlist context, when playing from a playlist queue. */
  playlistId?: string;
  /** This item's 0-based index within the playlist (for the next URL). */
  index?: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** All ladder rung names, highest first — mirrors the server quality ladder. */
const ALL_QUALITY_NAMES = ['1080p', '720p', '480p', '360p'] as const;

/**
 * Resolves a user's preferred quality against the rungs they may actually
 * select. `permitted` is the cap-and-below list from GET /api/qualities (highest
 * first). A preference at or below the cap is honoured; one above the cap clamps
 * down to the cap; an unset/unknown preference falls back to `fallback`.
 */
function clampToPermitted(
  preferred: string | null | undefined,
  permitted: string[],
  fallback: string,
): string {
  if (preferred === null || preferred === undefined || preferred === '') return fallback;
  if (permitted.includes(preferred)) return preferred;
  // A real rung that isn't permitted must be above the cap → clamp to the cap.
  if ((ALL_QUALITY_NAMES as readonly string[]).includes(preferred) && permitted.length > 0) {
    return permitted[0] as string;
  }
  return fallback;
}

/**
 * Whether a subtitle track's language satisfies a preference. Matches on an
 * exact (case-insensitive) code or a shared 2-letter prefix so a 2-letter
 * preference ("en") still selects a 3-letter track ("eng").
 */
function languageMatches(trackLanguage: string | null | undefined, preference: string): boolean {
  if (trackLanguage === null || trackLanguage === undefined || trackLanguage === '') return false;
  const track = trackLanguage.toLowerCase();
  const pref = preference.toLowerCase();
  return track === pref || track.slice(0, 2) === pref.slice(0, 2);
}

/** Reads an optional next-episode queue off the router location state. */
function readNextQueue(state: unknown): PlayDescriptor[] {
  if (typeof state !== 'object' || state === null) return [];
  const queue = (state as { queue?: unknown }).queue;
  if (!Array.isArray(queue)) return [];
  return queue.filter(
    (entry): entry is PlayDescriptor =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as PlayDescriptor).mediaFileId === 'string' &&
      typeof (entry as PlayDescriptor).itemId === 'string',
  );
}

/** Appends the streaming token to a segment/playlist URL when hls.js loads it. */
function appendToken(url: string, token: string): string {
  try {
    const resolved = new URL(url, window.location.origin);
    if (!resolved.searchParams.has('token')) resolved.searchParams.set('token', token);
    return resolved.toString();
  } catch {
    return url;
  }
}

/** Minimal shape of the hls.js default loader we subclass to inject the token. */
interface TokenLoaderContext {
  url: string;
}
type LoaderConstructor = new (config: HlsConfig) => {
  load(context: TokenLoaderContext, config: unknown, callbacks: unknown): void;
};

/**
 * hls.js config that appends the `?token=` to every playlist/segment request
 * (ffmpeg writes bare segment filenames, and hls.js does not propagate the
 * playlist's query to child requests). Returns an empty config when the default
 * loader is unavailable (e.g. the mocked hls.js in tests), so it never throws.
 */
function buildHlsConfig(token: string): Partial<HlsConfig> {
  const defaults = (Hls as unknown as { DefaultConfig?: { loader?: unknown } }).DefaultConfig;
  const BaseLoader = defaults?.loader;
  if (typeof BaseLoader !== 'function') return {};
  const Base = BaseLoader as LoaderConstructor;
  class TokenLoader extends Base {
    load(context: TokenLoaderContext, config: unknown, callbacks: unknown): void {
      context.url = appendToken(context.url, token);
      super.load(context, config, callbacks);
    }
  }
  return { loader: TokenLoader as unknown as HlsConfig['loader'] };
}

// ---- Playback engine --------------------------------------------------------

type PlaybackMode = 'direct' | 'transcode';

interface PlaybackEngine {
  videoSrc: string | undefined;
  playing: boolean;
  waiting: boolean;
  ended: boolean;
  currentTimeSec: number;
  durationSec: number;
  bufferedSec: number;
  volume: number;
  muted: boolean;
  mode: PlaybackMode;
  activeQuality: string;
  activeAudioIndex: number | null;
  loadError: string | null;
  togglePlay: () => void;
  play: () => void;
  seekTo: (sourceSec: number) => void;
  seekBy: (deltaSec: number) => void;
  changeVolumeBy: (delta: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  selectQuality: (value: string) => void;
  selectAudio: (index: number) => void;
  reportNow: () => void;
  retry: () => void;
}

interface EngineParams {
  /** The <video> ref, owned by the caller so it can bind it and read tracks. */
  videoRef: RefObject<HTMLVideoElement | null>;
  mediaFileId: string;
  itemId: string | null;
  decision: PlaybackDecision;
  sourceDurationSec: number;
  defaultQuality: string;
  /** Gate: begin playback only once the resume choice (if any) is made. */
  start: boolean;
  /** Source seconds to begin at (resume position, or 0). */
  startAtSec: number;
}

/**
 * Owns the <video> element and the HLS session: attaches the media, tracks
 * playback state, and exposes imperative controls. Everything mutable lives in
 * refs so the event-listener and lifecycle effects can stay stable (mounted
 * once) while still reading the latest values.
 */
function usePlaybackEngine(params: EngineParams): PlaybackEngine {
  const {
    videoRef,
    mediaFileId,
    itemId,
    decision,
    sourceDurationSec,
    defaultQuality,
    start,
    startAtSec,
  } = params;

  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<{ sessionId: string } | null>(null);
  // Monotonic token identifying the latest transcode start; a start whose token
  // is stale by the time its session resolves has been superseded and must be
  // discarded (its orphaned session freed) instead of attaching.
  const startGenerationRef = useRef(0);
  const startOffsetRef = useRef(0);
  const modeRef = useRef<PlaybackMode>(decision.action === 'direct' ? 'direct' : 'transcode');
  const activeQualityRef = useRef<string>('Original');
  const activeAudioRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const unmountedRef = useRef(false);
  const pendingSeekRef = useRef(0);
  // Latest source position (ms), kept fresh so the unmount report still has a
  // value after React has already detached the <video> ref.
  const lastPositionMsRef = useRef(0);

  // Prop mirrors so the stable callbacks always read the latest values. Synced
  // in an effect (never written during render) and declared first so the sync
  // runs before the begin-playback effect that reads them.
  const decisionRef = useRef(decision);
  const itemIdRef = useRef(itemId);
  const sourceDurationRef = useRef(sourceDurationSec);
  const defaultQualityRef = useRef(defaultQuality);
  const startAtRef = useRef(startAtSec);
  useEffect(() => {
    decisionRef.current = decision;
    itemIdRef.current = itemId;
    sourceDurationRef.current = sourceDurationSec;
    defaultQualityRef.current = defaultQuality;
    startAtRef.current = startAtSec;
  });

  // Reset the unmounted flag on every (re)mount. Without this, a StrictMode
  // remount (production mounts under StrictMode) leaves the flag stuck true from
  // the first mount's cleanup, so every in-flight transcode start would bail and
  // the video would never attach hls.js.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const [videoSrc, setVideoSrc] = useState<string | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [ended, setEnded] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [elementDuration, setElementDuration] = useState(0);
  const [bufferedSec, setBufferedSec] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [mode, setMode] = useState<PlaybackMode>(
    decision.action === 'direct' ? 'direct' : 'transcode',
  );
  const [activeQuality, setActiveQuality] = useState('Original');
  const [activeAudioIndex, setActiveAudioIndex] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const toSourceTime = useCallback(
    (elementTime: number) => startOffsetRef.current + elementTime,
    [],
  );

  const reportNow = useCallback(() => {
    const id = itemIdRef.current;
    if (id === null) return;
    const video = videoRef.current;
    let positionMs = lastPositionMsRef.current;
    let durationSec = sourceDurationRef.current;
    if (video !== null) {
      positionMs = toSourceTime(video.currentTime) * 1000;
      lastPositionMsRef.current = positionMs;
      if (durationSec <= 0 && Number.isFinite(video.duration) && modeRef.current === 'direct') {
        durationSec = video.duration;
      }
    }
    void reportProgress(id, positionMs, durationSec > 0 ? durationSec * 1000 : undefined).catch(
      () => {
        // Progress is best-effort; a failed report must never break playback.
      },
    );
  }, [toSourceTime, videoRef]);

  const play = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    const result = video.play() as unknown;
    if (result !== null && typeof result === 'object' && 'catch' in result) {
      (result as Promise<void>).catch(() => setPlaying(false));
    }
  }, [videoRef]);

  const teardownSession = useCallback(() => {
    if (hlsRef.current !== null) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session !== null) {
      void stopHlsSession(session.sessionId, decisionRef.current.streamToken).catch(() => {
        // Idempotent server-side; ignore failures freeing the slot.
      });
    }
  }, []);

  const attachHls = useCallback(
    (playlistUrl: string, token: string) => {
      const video = videoRef.current;
      if (video === null) return;
      // Defensive: never leave a previous instance attached to the element.
      if (hlsRef.current !== null) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (Hls.isSupported()) {
        const hls = new Hls(buildHlsConfig(token));
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_event: unknown, data: ErrorData) => {
          if (data.fatal) setLoadError('The video stream stopped unexpectedly.');
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => play());
        hls.loadSource(playlistUrl);
        hls.attachMedia(video);
        setVideoSrc(undefined);
      } else if (video.canPlayType('application/vnd.apple.mpegurl') !== '') {
        // Native HLS (Safari/iOS): the browser resolves segments against the
        // playlist URL; the token rides in that URL's query.
        setVideoSrc(playlistUrl);
        play();
      } else {
        setLoadError('This browser cannot play the transcoded stream.');
      }
    },
    [play, videoRef],
  );

  const startTranscode = useCallback(
    async (options: { quality: string; audioTrack: number | undefined; startOffset: number }) => {
      const token = decisionRef.current.streamToken;
      const generation = (startGenerationRef.current += 1);
      modeRef.current = 'transcode';
      setMode('transcode');
      teardownSession();
      let session;
      try {
        session = await startHlsSession(mediaFileId, token, {
          quality: options.quality,
          audioTrack: options.audioTrack,
          startOffset: options.startOffset,
        });
      } catch {
        if (generation === startGenerationRef.current) {
          setLoadError('Could not start the video stream. It may no longer be available.');
        }
        return;
      }
      // Unmounted, or a newer start superseded this one while it was in flight:
      // free this now-orphaned session and do NOT attach (avoids a double-attach
      // and a leaked transcode slot on rapid quality/audio switches).
      if (unmountedRef.current || generation !== startGenerationRef.current) {
        void stopHlsSession(session.sessionId, token).catch(() => {});
        return;
      }
      sessionRef.current = { sessionId: session.sessionId };
      startOffsetRef.current = session.startOffsetSec;
      activeQualityRef.current = session.quality;
      activeAudioRef.current = session.audioTrackIndex;
      setActiveQuality(session.quality);
      setActiveAudioIndex(session.audioTrackIndex);
      setCurrentTimeSec(session.startOffsetSec);
      attachHls(session.playlistUrl, token);
    },
    [attachHls, mediaFileId, teardownSession],
  );

  const startDirect = useCallback(
    (atSec: number) => {
      modeRef.current = 'direct';
      setMode('direct');
      startOffsetRef.current = 0;
      activeQualityRef.current = 'Original';
      setActiveQuality('Original');
      pendingSeekRef.current = atSec;
      setVideoSrc(decisionRef.current.action === 'direct' ? decisionRef.current.url : undefined);
      setCurrentTimeSec(atSec);
      const video = videoRef.current;
      if (video !== null && atSec > 0) video.currentTime = atSec;
      play();
    },
    [play, videoRef],
  );

  const beginPlayback = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setLoadError(null);
    const current = decisionRef.current;
    if (current.action === 'direct') {
      startDirect(startAtRef.current);
    } else {
      // `defaultQuality` is the user's preferred rung (clamped to their cap),
      // falling back to the server-chosen decision rung — so playback starts at
      // the preference rather than the bandwidth heuristic's pick.
      void startTranscode({
        quality: defaultQualityRef.current,
        audioTrack: undefined,
        startOffset: startAtRef.current,
      });
    }
  }, [startDirect, startTranscode]);

  const currentSourceTime = useCallback(() => {
    const video = videoRef.current;
    return video === null ? currentTimeSec : toSourceTime(video.currentTime);
  }, [currentTimeSec, toSourceTime, videoRef]);

  const isBuffered = useCallback((video: HTMLVideoElement, localTarget: number): boolean => {
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (localTarget >= ranges.start(i) - 0.5 && localTarget <= ranges.end(i) + 0.5) return true;
    }
    return false;
  }, []);

  const seekTo = useCallback(
    (sourceSec: number) => {
      const video = videoRef.current;
      if (video === null) return;
      const target = Math.max(0, sourceSec);
      if (modeRef.current === 'direct') {
        video.currentTime = target;
        setCurrentTimeSec(target);
        return;
      }
      const localTarget = target - startOffsetRef.current;
      if (localTarget >= 0 && isBuffered(video, localTarget)) {
        video.currentTime = localTarget;
        setCurrentTimeSec(target);
        return;
      }
      // Seeking outside the transcoded window: restart the session at the offset.
      setCurrentTimeSec(target);
      void startTranscode({
        quality:
          activeQualityRef.current !== 'Original'
            ? activeQualityRef.current
            : defaultQualityRef.current,
        audioTrack: activeAudioRef.current ?? undefined,
        startOffset: target,
      });
    },
    [isBuffered, startTranscode, videoRef],
  );

  const seekBy = useCallback(
    (deltaSec: number) => {
      seekTo(currentSourceTime() + deltaSec);
    },
    [currentSourceTime, seekTo],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) play();
    else video.pause();
  }, [play, videoRef]);

  const setVolume = useCallback(
    (value: number) => {
      const video = videoRef.current;
      const clamped = clamp01(value);
      setVolumeState(clamped);
      if (video !== null) {
        video.volume = clamped;
        if (clamped > 0 && video.muted) {
          video.muted = false;
          setMuted(false);
        }
      }
    },
    [videoRef],
  );

  const changeVolumeBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      const base = video !== null ? video.volume : volume;
      setVolume(base + delta);
    },
    [setVolume, volume, videoRef],
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, [videoRef]);

  const selectQuality = useCallback(
    (value: string) => {
      if (value === activeQualityRef.current) return;
      const sourceTime = currentSourceTime();
      if (value === 'Original' && decisionRef.current.action === 'direct') {
        teardownSession();
        startedRef.current = true;
        startDirect(sourceTime);
        return;
      }
      void startTranscode({
        quality: value,
        audioTrack: activeAudioRef.current ?? undefined,
        startOffset: sourceTime,
      });
    },
    [currentSourceTime, startDirect, startTranscode, teardownSession],
  );

  const selectAudio = useCallback(
    (index: number) => {
      if (index === activeAudioRef.current) return;
      const sourceTime = currentSourceTime();
      const quality =
        activeQualityRef.current !== 'Original'
          ? activeQualityRef.current
          : defaultQualityRef.current;
      void startTranscode({ quality, audioTrack: index, startOffset: sourceTime });
    },
    [currentSourceTime, startTranscode],
  );

  const retry = useCallback(() => {
    setLoadError(null);
    startedRef.current = false;
    setEnded(false);
    beginPlayback();
  }, [beginPlayback]);

  // Begin once the resume gate opens.
  useEffect(() => {
    if (start) beginPlayback();
  }, [start, beginPlayback]);

  // Media event listeners: attached once; they read refs for live values.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;

    const updateBuffered = () => {
      const ranges = video.buffered;
      const end = ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
      setBufferedSec(toSourceTime(end));
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      reportNow();
    };
    const onTimeUpdate = () => {
      const sourceTime = toSourceTime(video.currentTime);
      lastPositionMsRef.current = sourceTime * 1000;
      setCurrentTimeSec(sourceTime);
    };
    const onProgress = () => updateBuffered();
    const onVolumeChange = () => {
      setVolumeState(video.volume);
      setMuted(video.muted);
    };
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => {
      setWaiting(false);
      setPlaying(true);
    };
    const onEnded = () => {
      setPlaying(false);
      setEnded(true);
      reportNow();
    };
    const onDurationChange = () => {
      if (modeRef.current === 'direct' && Number.isFinite(video.duration)) {
        setElementDuration(video.duration);
      }
    };
    const onLoadedMetadata = () => {
      const target = pendingSeekRef.current;
      pendingSeekRef.current = 0;
      if (modeRef.current === 'direct' && target > 0) video.currentTime = target;
      onDurationChange();
      setVolumeState(video.volume);
      setMuted(video.muted);
    };
    const onError = () => {
      if (modeRef.current === 'direct') setLoadError('This video could not be played.');
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('progress', onProgress);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('ended', onEnded);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
    };
  }, [reportNow, toSourceTime, videoRef]);

  // Throttled progress reporting while mounted.
  useEffect(() => {
    if (itemId === null) return;
    const timer = window.setInterval(() => {
      if (!videoRef.current?.paused) reportNow();
    }, PROGRESS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [itemId, reportNow, videoRef]);

  // Final report + free the transcode session on unmount.
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      reportNow();
      teardownSession();
    };
  }, [reportNow, teardownSession]);

  const durationSec = sourceDurationSec > 0 ? sourceDurationSec : elementDuration;

  return {
    videoSrc,
    playing,
    waiting,
    ended,
    currentTimeSec,
    durationSec,
    bufferedSec,
    volume,
    muted,
    mode,
    activeQuality,
    activeAudioIndex,
    loadError,
    togglePlay,
    play,
    seekTo,
    seekBy,
    changeVolumeBy,
    setVolume,
    toggleMute,
    selectQuality,
    selectAudio,
    reportNow,
    retry,
  };
}

// ---- Overlays ---------------------------------------------------------------

function CenteredOverlay({ children }: { children: ReactNode }) {
  return <div className={styles.overlay}>{children}</div>;
}

function LoadingOverlay() {
  return (
    <CenteredOverlay>
      <div className={styles.overlayCard}>
        <Spinner label="Preparing playback" />
        <p className={styles.overlayText}>Preparing playback…</p>
      </div>
    </CenteredOverlay>
  );
}

function PlaybackErrorOverlay({
  title,
  message,
  onRetry,
  onBack,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  onBack: () => void;
}) {
  return (
    <CenteredOverlay>
      <div className={styles.overlayCard} role="alert">
        <h2 className={styles.overlayTitle}>{title}</h2>
        <p className={styles.overlayText}>{message}</p>
        <div className={styles.overlayActions}>
          {onRetry && (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Go back
          </button>
        </div>
      </div>
    </CenteredOverlay>
  );
}

function ResumePrompt({
  positionSec,
  onResume,
  onStartOver,
}: {
  positionSec: number;
  onResume: () => void;
  onStartOver: () => void;
}) {
  return (
    <CenteredOverlay>
      <div className={styles.overlayCard} role="dialog" aria-label="Resume playback">
        <h2 className={styles.overlayTitle}>Resume watching?</h2>
        <p className={styles.overlayText}>You stopped at {formatTime(positionSec)}.</p>
        <div className={styles.overlayActions}>
          <button type="button" className="btn btn-primary" onClick={onResume}>
            <PlayGlyph width={18} height={18} /> Resume from {formatTime(positionSec)}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onStartOver}>
            <ReplayGlyph width={18} height={18} /> Start over
          </button>
        </div>
      </div>
    </CenteredOverlay>
  );
}

function EndedOverlay({
  next,
  autoAdvance,
  onReplay,
  onPlayNext,
  onBack,
}: {
  next: PlayDescriptor | null;
  /** When false, "Up next" is offered but never auto-starts (user preference). */
  autoAdvance: boolean;
  onReplay: () => void;
  onPlayNext: () => void;
  onBack: () => void;
}) {
  const [countdown, setCountdown] = useState(NEXT_EPISODE_COUNTDOWN_S);

  useEffect(() => {
    if (next === null || !autoAdvance) return;
    if (countdown <= 0) {
      onPlayNext();
      return;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, next, autoAdvance, onPlayNext]);

  return (
    <CenteredOverlay>
      <div className={styles.overlayCard} role="dialog" aria-label="Playback finished">
        {next !== null ? (
          <>
            <h2 className={styles.overlayTitle}>Up next</h2>
            <p className={styles.overlayText}>
              {autoAdvance ? `${next.title} — starting in ${countdown}s` : next.title}
            </p>
            <div className={styles.overlayActions}>
              <button type="button" className="btn btn-primary" onClick={onPlayNext}>
                <PlayGlyph width={18} height={18} /> Play now
              </button>
              <button type="button" className="btn btn-ghost" onClick={onBack}>
                Back to details
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className={styles.overlayTitle}>Finished</h2>
            <div className={styles.overlayActions}>
              <button type="button" className="btn btn-primary" onClick={onReplay}>
                <ReplayGlyph width={18} height={18} /> Replay
              </button>
              <button type="button" className="btn btn-ghost" onClick={onBack}>
                Back to details
              </button>
            </div>
          </>
        )}
      </div>
    </CenteredOverlay>
  );
}

// ---- Stage (video + controls) -----------------------------------------------

interface StageProps {
  mediaFileId: string;
  itemId: string | null;
  title: string;
  decision: PlaybackDecision;
  sourceDurationSec: number;
  resumePositionSec: number;
  defaultQuality: string;
  qualityRungs: string[];
  /** The user's preferred subtitle language (ISO code / "off"), or null. */
  preferredSubtitleLanguage: string | null;
  /** Whether the next episode auto-advances when playback ends. */
  autoplayNextEpisode: boolean;
  /** Chapter markers for the current file's timeline; empty when none. */
  chapters: ChapterInfo[];
  nextQueue: PlayDescriptor[];
  onBack: () => void;
}

function PlayerStage(props: StageProps) {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const needsResume = props.itemId !== null && props.resumePositionSec > 0;
  const [resumeResolved, setResumeResolved] = useState(!needsResume);
  const [startAtSec, setStartAtSec] = useState(0);
  const [interactionVisible, setInteractionVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  // `undefined` == the user hasn't chosen yet, so the preferred-language
  // preselection applies; `null` == explicitly off; a string == a chosen track.
  const [subtitleChoice, setSubtitleChoice] = useState<string | null | undefined>(undefined);

  const engine = usePlaybackEngine({
    videoRef,
    mediaFileId: props.mediaFileId,
    itemId: props.itemId,
    decision: props.decision,
    sourceDurationSec: props.sourceDurationSec,
    defaultQuality: props.defaultQuality,
    start: resumeResolved,
    startAtSec,
  });

  const token = props.decision.streamToken;

  // Scrub-preview tile map (token-authed; null when the file has no trickplay,
  // so the seek bar simply shows no hover thumbnail).
  const trickplayQuery = useTrickplayManifest(props.mediaFileId, token);
  const trickplay = trickplayQuery.data ?? null;

  // Audio + subtitle track listings (token-authed; enabled once we have a token).
  const audioQuery = useQuery({
    queryKey: playerKeys.audio(props.mediaFileId),
    queryFn: () => getAudioTracks(props.mediaFileId, token),
  });
  const subtitleQuery = useQuery({
    queryKey: playerKeys.subtitles(props.mediaFileId),
    queryFn: () => getSubtitleTracks(props.mediaFileId, token),
  });

  const audioTracks: PlayerAudioTrack[] = useMemo(() => audioQuery.data ?? [], [audioQuery.data]);
  const subtitleTracks: PlayerSubtitleTrack[] = useMemo(
    () => subtitleQuery.data ?? [],
    [subtitleQuery.data],
  );
  const textSubtitles = useMemo(
    () => subtitleTracks.filter((track) => track.kind === 'text'),
    [subtitleTracks],
  );

  // The track pre-selected by the user's preferred language (derived, not an
  // effect): the first text track whose language matches. Null when the
  // preference is unset or "off"/"none" (never auto-enable) or nothing matches.
  const preselectedSubtitleId = useMemo(() => {
    const pref = props.preferredSubtitleLanguage;
    if (pref === null || pref === '' || pref === 'off' || pref === 'none') return null;
    return textSubtitles.find((track) => languageMatches(track.language, pref))?.id ?? null;
  }, [textSubtitles, props.preferredSubtitleLanguage]);

  // The active subtitle: the user's explicit choice once made, otherwise the
  // preferred-language preselection. Keeps the preselection from clobbering a
  // later manual on/off without any setState-in-effect.
  const activeSubtitleId = subtitleChoice !== undefined ? subtitleChoice : preselectedSubtitleId;

  // Reflect the chosen subtitle onto the <track> elements' modes.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const tracks = video.textTracks;
    textSubtitles.forEach((sub, index) => {
      const textTrack = tracks[index];
      if (textTrack === undefined) return;
      textTrack.mode = sub.id === activeSubtitleId ? 'showing' : 'disabled';
    });
  }, [activeSubtitleId, textSubtitles]);

  // Mark recent activity; the bar hides 3s later. Controls also stay shown
  // whenever paused (derived below), so the timer needn't inspect play state.
  const showControls = useCallback(() => {
    setInteractionVisible(true);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setInteractionVisible(false), CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  // Controls are shown on recent activity OR whenever playback is paused.
  const controlsShown = interactionVisible || !engine.playing;

  const toggleSubtitles = useCallback(() => {
    setSubtitleChoice((current) => {
      const active = current !== undefined ? current : preselectedSubtitleId;
      if (active !== null) return null;
      return textSubtitles[0]?.id ?? null;
    });
  }, [textSubtitles, preselectedSubtitleId]);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (!document.fullscreenElement) {
      void container.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      let handled = true;
      switch (event.key) {
        case ' ':
        case 'k':
          engine.togglePlay();
          break;
        case 'ArrowRight':
          engine.seekBy(SEEK_STEP_SECONDS);
          break;
        case 'ArrowLeft':
          engine.seekBy(-SEEK_STEP_SECONDS);
          break;
        case 'ArrowUp':
          engine.changeVolumeBy(VOLUME_STEP);
          break;
        case 'ArrowDown':
          engine.changeVolumeBy(-VOLUME_STEP);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          engine.toggleMute();
          break;
        case 'c':
          toggleSubtitles();
          break;
        default:
          handled = false;
      }
      if (handled) {
        event.preventDefault();
        showControls();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [engine, showControls, toggleFullscreen, toggleSubtitles]);

  // Depends on the STABLE engine.reportNow (not the per-render engine object) so
  // its identity is stable — otherwise the EndedOverlay countdown effect, which
  // lists onPlayNext as a dependency, would restart its 1s timer on every
  // re-render and never reach zero.
  const reportNow = engine.reportNow;
  const goToNext = useCallback(() => {
    const [next, ...rest] = props.nextQueue;
    if (next === undefined) return;
    reportNow();
    const query = new URLSearchParams({ item: next.itemId });
    // Playlist queue: carry the playlist context in the URL so the next item is
    // refresh-safe/shareable (the player re-derives the tail from the server).
    if (next.playlistId !== undefined && next.index !== undefined) {
      query.set('playlist', next.playlistId);
      query.set('index', String(next.index));
    }
    navigate(`/player/${encodeURIComponent(next.mediaFileId)}?${query.toString()}`, {
      state: { queue: rest },
    });
  }, [navigate, props.nextQueue, reportNow]);

  const qualityOptions: QualityOption[] = useMemo(() => {
    const rungs: QualityOption[] = props.qualityRungs.map((name) => ({ value: name, label: name }));
    if (props.decision.action === 'direct') {
      return [{ value: 'Original', label: 'Original (direct play)' }, ...rungs];
    }
    return rungs;
  }, [props.decision.action, props.qualityRungs]);

  const audioOptions: TrackOption[] = useMemo(
    () => audioTracks.map((track) => ({ value: String(track.index), label: track.label })),
    [audioTracks],
  );
  const subtitleOptions: TrackOption[] = useMemo(
    () =>
      subtitleTracks.map((track) => ({
        value: track.id,
        label: track.label,
        disabled: track.kind === 'image',
        disabledReason: track.kind === 'image' ? IMAGE_SUB_REASON : undefined,
      })),
    [subtitleTracks],
  );

  const next = props.nextQueue[0] ?? null;

  return (
    <div
      ref={containerRef}
      className={styles.stage}
      data-testid="player-stage"
      onMouseMove={showControls}
      onTouchStart={showControls}
      onClick={showControls}
      style={{ cursor: controlsShown ? 'default' : 'none' }}
    >
      <video
        ref={videoRef}
        className={styles.video}
        data-testid="player-video"
        src={engine.videoSrc}
        playsInline
        preload="auto"
        onDoubleClick={toggleFullscreen}
      >
        {textSubtitles.map((sub) => (
          <track
            key={sub.id}
            kind="subtitles"
            src={subtitleVttUrl(props.mediaFileId, sub.id, token)}
            srcLang={sub.language ?? undefined}
            label={sub.label}
          />
        ))}
      </video>

      {engine.waiting && !engine.loadError && (
        <div className={styles.bufferingSpinner} aria-hidden="true">
          <Spinner />
        </div>
      )}

      {engine.loadError !== null ? (
        <PlaybackErrorOverlay
          title="Playback error"
          message={engine.loadError}
          onRetry={engine.retry}
          onBack={props.onBack}
        />
      ) : !resumeResolved ? (
        <ResumePrompt
          positionSec={props.resumePositionSec}
          onResume={() => {
            setStartAtSec(props.resumePositionSec);
            setResumeResolved(true);
          }}
          onStartOver={() => {
            setStartAtSec(0);
            setResumeResolved(true);
          }}
        />
      ) : engine.ended ? (
        <EndedOverlay
          next={next}
          autoAdvance={props.autoplayNextEpisode}
          onReplay={engine.retry}
          onPlayNext={goToNext}
          onBack={props.onBack}
        />
      ) : null}

      <PlayerControls
        title={props.title}
        visible={controlsShown && engine.loadError === null && resumeResolved && !engine.ended}
        playing={engine.playing}
        onPlayPause={engine.togglePlay}
        currentTimeSec={engine.currentTimeSec}
        durationSec={engine.durationSec}
        bufferedSec={engine.bufferedSec}
        onSeek={engine.seekTo}
        volume={engine.volume}
        muted={engine.muted}
        onVolume={engine.setVolume}
        onToggleMute={engine.toggleMute}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onBack={props.onBack}
        qualityOptions={qualityOptions}
        activeQuality={engine.activeQuality}
        onSelectQuality={engine.selectQuality}
        audioOptions={audioOptions}
        activeAudioId={engine.activeAudioIndex === null ? null : String(engine.activeAudioIndex)}
        onSelectAudio={(value) => engine.selectAudio(Number(value))}
        subtitleOptions={subtitleOptions}
        activeSubtitleId={activeSubtitleId}
        onSelectSubtitle={(value) => setSubtitleChoice(value)}
        onActivity={showControls}
        mediaFileId={props.mediaFileId}
        streamToken={token}
        trickplay={trickplay}
        chapters={props.chapters}
      />
    </div>
  );
}

// ---- Route entry ------------------------------------------------------------

/**
 * The autoplay queue when playing from a playlist: the remaining playable items
 * after `index`, as PlayDescriptors carrying the playlist context. Empty (and
 * fires no request) when there is no playlist. Refresh-safe — it re-derives from
 * the server on every hop rather than relying on navigation state.
 */
function usePlaylistQueue(playlistId: string | null, index: number | null): PlayDescriptor[] {
  const query = usePlaylist(playlistId ?? '', { enabled: playlistId !== null });
  const items = query.data?.items;
  return useMemo(() => {
    if (playlistId === null || index === null || items === undefined) return [];
    return items
      .filter((item) => item.order > index && item.hasFile && item.primaryMediaFileId !== null)
      .map((item) => ({
        mediaFileId: item.primaryMediaFileId as string,
        itemId: item.id,
        title: item.title,
        playlistId,
        index: item.order,
      }));
  }, [playlistId, index, items]);
}

function PlayerView({
  mediaFileId,
  itemId,
  playlistId,
  playlistIndex,
}: {
  mediaFileId: string;
  itemId: string | null;
  playlistId: string | null;
  playlistIndex: number | null;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const capabilities = useMemo(() => detectClientCapabilities(), []);
  const decisionQuery = usePlaybackDecision(mediaFileId, capabilities);
  const detailQuery = useItemDetail(itemId ?? '', { enabled: itemId !== null });
  const qualitiesQuery = useQualities();

  const stateQueue = useMemo(() => readNextQueue(location.state), [location.state]);
  const playlistQueue = usePlaylistQueue(playlistId, playlistIndex);
  // A playlist context (from the URL) drives the queue when present; otherwise
  // fall back to the next-episode queue passed via navigation state.
  const nextQueue = playlistId !== null ? playlistQueue : stateQueue;

  const onBack = useCallback(() => {
    if (itemId !== null) navigate(`/items/${itemId}`);
    else navigate(-1);
  }, [itemId, navigate]);

  const decisionPending = decisionQuery.isPending;
  const detailPending = itemId !== null && detailQuery.isPending;

  if (decisionQuery.isError) {
    const error = decisionQuery.error;
    const status = error instanceof ApiError ? error.status : 0;
    const forbidden = status === 401 || status === 403 || status === 404;
    return (
      <div className={styles.page}>
        <PlaybackErrorOverlay
          title={forbidden ? 'Unavailable' : "Couldn't start playback"}
          message={
            forbidden
              ? "This video doesn't exist, or you no longer have access to it."
              : 'Something went wrong preparing this video. Please try again.'
          }
          onRetry={forbidden ? undefined : () => void decisionQuery.refetch()}
          onBack={onBack}
        />
      </div>
    );
  }

  if (decisionPending || detailPending) {
    return (
      <div className={styles.page}>
        <LoadingOverlay />
      </div>
    );
  }

  const decision = decisionQuery.data;
  const detail = detailQuery.data;
  const file = detail?.files.find((candidate) => candidate.id === mediaFileId) ?? detail?.files[0];
  const chapters = file?.chapters ?? [];
  const durationMs = file?.durationMs ?? detail?.item.runtimeMs ?? null;
  const sourceDurationSec = durationMs !== null && durationMs > 0 ? durationMs / 1000 : 0;
  const watchState = detail?.item.watchState;
  const resumePositionSec =
    watchState !== undefined && !watchState.watched && watchState.positionMs > 0
      ? watchState.positionMs / 1000
      : 0;
  const title = detail?.item.title ?? 'Now playing';
  const qualityRungs = qualitiesQuery.data?.qualities.map((rung) => rung.name) ?? [];
  const serverDefaultQuality = qualitiesQuery.data?.defaultQuality ?? '720p';
  // Start at the user's preferred rung (clamped to the rungs they may select),
  // falling back to the server-chosen decision rung / server default.
  const decisionFallback =
    decision.action === 'transcode' ? decision.quality : serverDefaultQuality;
  const initialQuality = clampToPermitted(user?.preferredQuality, qualityRungs, decisionFallback);

  return (
    <div className={styles.page}>
      <PlayerStage
        mediaFileId={mediaFileId}
        itemId={itemId}
        title={title}
        decision={decision}
        sourceDurationSec={sourceDurationSec}
        resumePositionSec={resumePositionSec}
        defaultQuality={initialQuality}
        qualityRungs={qualityRungs}
        preferredSubtitleLanguage={user?.preferredSubtitleLanguage ?? null}
        autoplayNextEpisode={user?.autoplayNextEpisode ?? true}
        chapters={chapters}
        nextQueue={nextQueue}
        onBack={onBack}
      />
    </div>
  );
}

/** Route entry for `/player/:mediaFileId?item=:itemId&playlist=:id&index=N`. */
export function PlayerPage() {
  const { mediaFileId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const itemId = searchParams.get('item');
  const playlistId = searchParams.get('playlist');
  const indexParam = searchParams.get('index');
  const playlistIndex =
    indexParam !== null && Number.isFinite(Number(indexParam)) ? Number(indexParam) : null;
  // Key on the file id so navigating between items fully remounts the engine.
  return (
    <PlayerView
      key={mediaFileId}
      mediaFileId={mediaFileId}
      itemId={itemId}
      playlistId={playlistId}
      playlistIndex={playlistIndex}
    />
  );
}
