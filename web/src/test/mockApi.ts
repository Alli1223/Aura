import { vi, type Mock } from 'vitest';

import type { ActivitySession } from '../api/activity';
import type { AccessMatrix, AdminSettings, AdminUser, ScanState, TaskStatus } from '../api/admin';
import type { AdminStats } from '../api/adminStats';
import type { DetailEpisode, ItemDetail, MediaFileInfo } from '../api/detail';
import type { HistoryEntry } from '../api/history';
import type { ContinueWatchingEntry } from '../api/home';
import type { MediaItem } from '../api/media';
import type {
  PlaybackDecision,
  PlayerAudioTrack,
  PlayerSubtitleTrack,
  QualitiesResponse,
} from '../api/player';
import type { AuthUser, Library, LibraryType, PublicSettings } from '../api/types';

/** Fixed token the mock server hands back so tests can assert bearer headers. */
export const MOCK_ACCESS_TOKEN = 'access-token';

/** Quality-ladder rung names, mirrored so the PATCH /me mock can reject bad ones. */
const QUALITY_LADDER_NAMES = ['1080p', '720p', '480p', '360p'] as const;

export function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    username: 'alli',
    email: null,
    role: 'user',
    isEnabled: true,
    mustChangePassword: false,
    preferredQuality: null,
    preferredSubtitleLanguage: null,
    autoplayNextEpisode: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

let libraryCounter = 0;
export function makeLibrary(name: string, type: LibraryType = 'movies'): Library {
  libraryCounter += 1;
  return {
    id: `lib-${libraryCounter}`,
    name,
    type,
    paths: [`/media/${type}`],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let adminUserCounter = 0;
/** An admin-view user (== server toAuthUser, includes maxQuality). */
export function makeAdminUser(overrides: Partial<AdminUser> = {}): AdminUser {
  adminUserCounter += 1;
  return {
    id: overrides.id ?? `au-${adminUserCounter}`,
    username: `user${adminUserCounter}`,
    email: null,
    role: 'user',
    isEnabled: true,
    mustChangePassword: false,
    maxQuality: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

let taskCounter = 0;
/** A scheduled-task status with idle defaults. */
export function makeTask(overrides: Partial<TaskStatus> = {}): TaskStatus {
  taskCounter += 1;
  return {
    id: overrides.id ?? `task-${taskCounter}`,
    name: `Task ${taskCounter}`,
    enabled: true,
    intervalMs: 3_600_000,
    state: 'idle',
    lastRunAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
    nextRunAt: null,
    runCount: 0,
    ...overrides,
  };
}

let activityCounter = 0;
/** A live transcode session for the admin activity dashboard. */
export function makeActivitySession(overrides: Partial<ActivitySession> = {}): ActivitySession {
  activityCounter += 1;
  return {
    id: overrides.id ?? `session-${activityCounter}`,
    userId: overrides.userId ?? `user-${activityCounter}`,
    username: overrides.username ?? `viewer${activityCounter}`,
    mediaFileId: overrides.mediaFileId ?? `file-${activityCounter}`,
    mediaItemId: overrides.mediaItemId ?? `item-${activityCounter}`,
    title: overrides.title ?? `Movie ${activityCounter}`,
    itemType: overrides.itemType ?? 'movie',
    quality: overrides.quality ?? '720p',
    audioTrackIndex: overrides.audioTrackIndex ?? 0,
    downmixStereo: overrides.downmixStereo ?? true,
    startOffsetSec: overrides.startOffsetSec ?? 0,
    burnSubtitleTrackId: overrides.burnSubtitleTrackId ?? null,
    transcode: overrides.transcode ?? true,
    burningSubtitle: overrides.burningSubtitle ?? false,
    createdAt: overrides.createdAt ?? '2026-06-01T10:00:00.000Z',
    lastAccess: overrides.lastAccess ?? '2026-06-01T10:01:00.000Z',
    state: overrides.state ?? 'ready',
  };
}

const DEFAULT_ADMIN_SETTINGS: AdminSettings = {
  serverName: 'Test Server',
  registrationEnabled: true,
  baseUrl: '',
  transcodeDir: '/config/transcodes',
  defaultQuality: '720p',
  maxQuality: '1080p',
  tmdbApiKey: '',
};

let itemCounter = 0;
/** A serialized media item with sensible defaults; override any field. */
export function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  itemCounter += 1;
  const id = overrides.id ?? `item-${itemCounter}`;
  const base: MediaItem = {
    id,
    libraryId: 'lib-1',
    type: 'movie',
    title: `Item ${itemCounter}`,
    sortTitle: `item ${String(itemCounter).padStart(4, '0')}`,
    year: 2020,
    overview: null,
    tagline: null,
    runtimeMs: null,
    contentRating: null,
    communityRating: null,
    genres: [],
    posterUrl: `/api/items/${id}/artwork/poster`,
    backdropUrl: null,
    seasonNumber: null,
    episodeNumber: null,
    absoluteEpisodeNumber: null,
    addedAt: '2026-01-01T00:00:00.000Z',
    watchState: {
      watched: false,
      positionMs: 0,
      episodeCount: 0,
      watchedEpisodeCount: 0,
      nextUnwatchedId: null,
    },
  };
  return {
    ...base,
    ...overrides,
    watchState: { ...base.watchState, ...overrides.watchState },
  };
}

let continueCounter = 0;
/** A continue-watching entry with sensible in-progress defaults. */
export function makeContinueEntry(
  overrides: Partial<Omit<ContinueWatchingEntry, 'item'>> & {
    item?: Partial<ContinueWatchingEntry['item']>;
  } = {},
): ContinueWatchingEntry {
  continueCounter += 1;
  const itemId = overrides.item?.id ?? `cw-${continueCounter}`;
  const base: ContinueWatchingEntry = {
    mediaItemId: itemId,
    positionMs: 30_000,
    updatedAt: `2026-02-${String(continueCounter).padStart(2, '0')}T00:00:00.000Z`,
    item: {
      id: itemId,
      type: 'movie',
      title: `Continue ${continueCounter}`,
      seasonNumber: null,
      episodeNumber: null,
      parentId: null,
      libraryId: 'lib-1',
      posterPath: '/cache/poster.webp',
      runtimeMs: 120_000,
    },
  };
  return {
    ...base,
    ...overrides,
    item: { ...base.item, ...overrides.item },
  };
}

/** A watch-history entry (serialized item + its watch state + show context). */
export function makeHistoryEntry(
  overrides: Partial<Omit<HistoryEntry, 'item' | 'watchState'>> & {
    item?: Partial<MediaItem>;
    watchState?: Partial<HistoryEntry['watchState']>;
  } = {},
): HistoryEntry {
  const item = makeItem(overrides.item ?? {});
  return {
    item,
    watchState: {
      positionMs: 0,
      watched: true,
      watchedAt: '2026-02-01T00:00:00.000Z',
      playCount: 1,
      lastActivity: item.addedAt,
      ...overrides.watchState,
    },
    showId: overrides.showId ?? null,
    showTitle: overrides.showTitle ?? null,
  };
}

/** A server-wide admin-stats payload with empty/zeroed defaults. */
export function makeAdminStats(overrides: Partial<AdminStats> = {}): AdminStats {
  return {
    totals: overrides.totals ?? {
      users: 0,
      libraries: 0,
      files: 0,
      items: { movie: 0, show: 0, season: 0, episode: 0, total: 0 },
    },
    storageByLibrary: overrides.storageByLibrary ?? [],
    mostWatched: overrides.mostWatched ?? [],
    mostActiveUsers: overrides.mostActiveUsers ?? [],
    recentlyAdded: overrides.recentlyAdded ?? { last24h: 0, last7d: 0, last30d: 0 },
  };
}

let fileCounter = 0;
/** A serialized media file (with streams) carrying sensible defaults. */
export function makeFile(overrides: Partial<MediaFileInfo> = {}): MediaFileInfo {
  fileCounter += 1;
  return {
    id: `file-${fileCounter}`,
    container: 'mkv',
    width: 1920,
    height: 1080,
    durationMs: 7_200_000,
    bitrate: 8_000_000,
    videoCodec: 'h264',
    size: 4_000_000_000,
    audioStreams: [],
    subtitleStreams: [],
    ...overrides,
  };
}

/** A serialized episode (MediaItem + play info), defaulting to one playable file. */
export function makeEpisode(overrides: Partial<DetailEpisode> = {}): DetailEpisode {
  const { hasFile, primaryMediaFileId, ...itemOverrides } = overrides;
  const item = makeItem({ type: 'episode', ...itemOverrides });
  return {
    ...item,
    hasFile: hasFile ?? true,
    primaryMediaFileId: primaryMediaFileId !== undefined ? primaryMediaFileId : `${item.id}-file`,
  };
}

/** An ItemDetail payload with the sub-collections defaulted to empty. */
export function makeDetail(
  item: MediaItem,
  extra: Partial<Omit<ItemDetail, 'item'>> = {},
): ItemDetail {
  return {
    item,
    files: extra.files ?? [],
    seasons: extra.seasons ?? [],
    episodes: extra.episodes ?? [],
  };
}

/** The fixed streaming token the mock decide endpoint mints. */
export const MOCK_STREAM_TOKEN = 'stream-token';

/** A direct-play decision (mirrors the server's /stream/decide direct shape). */
export function makeDirectDecision(mediaFileId: string): PlaybackDecision {
  return {
    action: 'direct',
    reasons: ['within client capabilities'],
    streamToken: MOCK_STREAM_TOKEN,
    expiresAt: '2026-01-01T01:00:00.000Z',
    url: `/api/stream/direct/${mediaFileId}?token=${MOCK_STREAM_TOKEN}`,
  };
}

/** A transcode decision (mirrors the server's /stream/decide transcode shape). */
export function makeTranscodeDecision(mediaFileId: string, quality = '720p'): PlaybackDecision {
  return {
    action: 'transcode',
    reasons: ['video codec not supported by the client'],
    transcodeReason: 'video-codec',
    transcodeReasons: ['video-codec'],
    quality,
    streamToken: MOCK_STREAM_TOKEN,
    expiresAt: '2026-01-01T01:00:00.000Z',
    hlsStartUrl: `/api/stream/hls/${mediaFileId}?token=${MOCK_STREAM_TOKEN}&quality=${quality}`,
  };
}

/** The GET /api/qualities payload, defaulting to the full ladder. */
export function makeQualities(overrides: Partial<QualitiesResponse> = {}): QualitiesResponse {
  return {
    maxQuality: overrides.maxQuality ?? '1080p',
    defaultQuality: overrides.defaultQuality ?? '720p',
    qualities: overrides.qualities ?? [
      { name: '1080p', maxWidth: 1920, videoBitrate: '6000k', audioBitrate: '192k' },
      { name: '720p', maxWidth: 1280, videoBitrate: '3000k', audioBitrate: '160k' },
      { name: '480p', maxWidth: 854, videoBitrate: '1400k', audioBitrate: '128k' },
      { name: '360p', maxWidth: 640, videoBitrate: '800k', audioBitrate: '96k' },
    ],
  };
}

/** One audio track for GET /stream/audio. */
export function makeAudioTrack(overrides: Partial<PlayerAudioTrack> = {}): PlayerAudioTrack {
  const index = overrides.index ?? 0;
  return {
    index,
    codec: overrides.codec ?? 'aac',
    channels: overrides.channels ?? 2,
    channelLayout: overrides.channelLayout ?? 'Stereo',
    language: overrides.language ?? 'eng',
    title: overrides.title,
    default: overrides.default ?? index === 0,
    label: overrides.label ?? `English Stereo (AAC)`,
  };
}

/** One subtitle track for GET /stream/subtitles. */
export function makeSubtitleTrack(
  overrides: Partial<PlayerSubtitleTrack> = {},
): PlayerSubtitleTrack {
  const kind = overrides.kind ?? 'text';
  return {
    id: overrides.id ?? 'embedded-2',
    source: overrides.source ?? 'embedded',
    kind,
    format: overrides.format ?? (kind === 'image' ? 'pgs' : 'srt'),
    codec: overrides.codec,
    language: overrides.language ?? 'eng',
    title: overrides.title,
    forced: overrides.forced ?? false,
    default: overrides.default ?? false,
    label: overrides.label ?? 'English',
  };
}

export interface MockApiConfig {
  serverName?: string;
  registrationEnabled?: boolean;
  /** The user a boot refresh restores. null → no session (logged out). */
  session?: AuthUser | null;
  libraries?: Library[];
  /** Top-level items keyed by libraryId, served by GET /libraries/:id/items. */
  items?: Record<string, MediaItem[]>;
  /** In-progress entries served by GET /continue-watching. */
  continueWatching?: ContinueWatchingEntry[];
  /** Watch-history entries served (paginated) by GET /history. */
  history?: HistoryEntry[];
  /** Server-wide stats served by GET /admin/stats. */
  adminStats?: AdminStats;
  /** Item detail payloads keyed by item id, served by GET /items/:id. */
  details?: Record<string, ItemDetail>;
  /** Current password accepted by login / change-password. */
  password?: string;
  /** User returned by a successful login/register (defaults to the session). */
  authUser?: AuthUser;
  /** Admin user list served by GET /users. */
  adminUsers?: AdminUser[];
  /** Access matrix served by GET /access. */
  access?: AccessMatrix;
  /** Server settings served by GET /settings (merged over defaults). */
  settings?: Partial<AdminSettings>;
  /** Scheduled tasks served by GET /tasks. */
  tasks?: TaskStatus[];
  /** Live transcode sessions served by GET /activity/sessions. */
  activitySessions?: ActivitySession[];
  /** When true, GET /activity/sessions responds 500 (drives the error state). */
  activitySessionsError?: boolean;
  /** Preset scan states keyed by library id. */
  scans?: Record<string, ScanState>;
  /** POST /tasks/:id/run returns 409 TASK_RUNNING for this task id. */
  taskRunConflictId?: string;
  /** Playback decisions keyed by mediaFileId (default: direct play). */
  decisions?: Record<string, PlaybackDecision>;
  /** GET /api/qualities payload (default: full ladder). */
  qualities?: QualitiesResponse;
  /** Audio tracks keyed by mediaFileId (GET /stream/audio). */
  audioTracks?: Record<string, PlayerAudioTrack[]>;
  /** Subtitle tracks keyed by mediaFileId (GET /stream/subtitles). */
  subtitles?: Record<string, PlayerSubtitleTrack[]>;
}

export interface MockApi {
  fetchMock: Mock;
  refreshSpy: Mock;
  state: {
    publicSettings: PublicSettings;
    session: AuthUser | null;
    libraries: Library[];
    items: Record<string, MediaItem[]>;
    continueWatching: ContinueWatchingEntry[];
    history: HistoryEntry[];
    adminStats: AdminStats;
    details: Record<string, ItemDetail>;
    password: string;
    authUser: AuthUser | null;
    adminUsers: AdminUser[];
    access: AccessMatrix;
    settings: AdminSettings;
    tasks: TaskStatus[];
    activitySessions: ActivitySession[];
    scans: Record<string, ScanState>;
    decisions: Record<string, PlaybackDecision>;
    qualities: QualitiesResponse;
    audioTracks: Record<string, PlayerAudioTrack[]>;
    subtitles: Record<string, PlayerSubtitleTrack[]>;
    /** Monotonic counter so each HLS start returns a distinct session id. */
    hlsSessionCounter: number;
  };
}

/** Re-derives a container detail's watch-state roll-up from its episodes. */
function rollUpDetail(detail: ItemDetail): void {
  const episodes = detail.episodes;
  let watchedEpisodeCount = 0;
  let nextUnwatchedId: string | null = null;
  let positionMs = 0;
  for (const episode of episodes) {
    if (episode.watchState.watched) watchedEpisodeCount += 1;
    else if (nextUnwatchedId === null) {
      nextUnwatchedId = episode.id;
      positionMs = episode.watchState.positionMs;
    }
  }
  detail.item = {
    ...detail.item,
    watchState: {
      ...detail.item.watchState,
      watched: episodes.length > 0 && watchedEpisodeCount === episodes.length,
      positionMs,
      episodeCount: episodes.length,
      watchedEpisodeCount,
      nextUnwatchedId,
    },
  };
}

/**
 * Applies a watched flag to the stored detail state, mirroring the server's
 * cascade so a post-mutation refetch stays consistent: a movie/episode marks
 * itself, a season/show cascades to its episodes, and any parent season that
 * lists the toggled episode has its roll-up re-derived.
 */
function applyWatchedToDetails(
  details: Record<string, ItemDetail>,
  id: string,
  watched: boolean,
): { type: string; affectedCount: number } {
  let type = 'movie';
  let affectedCount = 1;

  const own = details[id];
  if (own !== undefined) {
    type = own.item.type;
    if (type === 'season' || type === 'show') {
      own.episodes = own.episodes.map((episode) => ({
        ...episode,
        watchState: { ...episode.watchState, watched, positionMs: 0 },
      }));
      affectedCount = own.episodes.length;
      rollUpDetail(own);
    } else {
      own.item = { ...own.item, watchState: { ...own.item.watchState, watched, positionMs: 0 } };
    }
  }

  // Reflect an episode toggle inside any parent season that lists it.
  for (const detail of Object.values(details)) {
    if (!detail.episodes.some((episode) => episode.id === id)) continue;
    detail.episodes = detail.episodes.map((episode) =>
      episode.id === id
        ? { ...episode, watchState: { ...episode.watchState, watched, positionMs: 0 } }
        : episode,
    );
    rollUpDetail(detail);
  }

  return { type, affectedCount };
}

function err(code: string, message: string) {
  return { error: { code, message } };
}

function hasBearer(init: RequestInit | undefined): boolean {
  const auth = new Headers(init?.headers).get('Authorization');
  return auth !== null && auth.startsWith('Bearer ');
}

/** Sort key extractor mirroring the server's ordering fields. */
function itemSortValue(item: MediaItem, sort: string): number | string {
  switch (sort) {
    case 'year':
      return item.year ?? 0;
    case 'added':
      return item.addedAt;
    case 'rating':
      return item.communityRating ?? 0;
    default:
      return item.sortTitle;
  }
}

/** Applies the browse query (filter → sort → paginate) like the real endpoint. */
function listItems(all: MediaItem[], query: URLSearchParams) {
  let list = all.slice();
  const search = query.get('search');
  if (search !== null && search !== '') {
    const needle = search.toLowerCase();
    list = list.filter((item) => item.title.toLowerCase().includes(needle));
  }
  const genre = query.get('genre');
  if (genre !== null && genre !== '') list = list.filter((item) => item.genres.includes(genre));
  const year = query.get('year');
  if (year !== null && year !== '') list = list.filter((item) => item.year === Number(year));
  const watched = query.get('watched');
  if (watched === 'true') list = list.filter((item) => item.watchState.watched);
  else if (watched === 'false') list = list.filter((item) => !item.watchState.watched);

  const sort = query.get('sort') ?? 'title';
  list.sort((a, b) => {
    const av = itemSortValue(a, sort);
    const bv = itemSortValue(b, sort);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  if (query.get('order') === 'desc') list.reverse();

  const page = Number(query.get('page') ?? '1');
  const pageSize = Number(query.get('pageSize') ?? '48');
  const total = list.length;
  const start = (page - 1) * pageSize;
  return { items: list.slice(start, start + pageSize), page, pageSize, total };
}

/** Most-recently-added first, capped at `limit` — mirrors the recently-added feeds. */
function recentlyAdded(all: MediaItem[], limit: number): MediaItem[] {
  return all
    .slice()
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0))
    .slice(0, limit);
}

/** Match tier for the search rerank (lower is better), mirroring the server. */
function searchRank(title: string, needle: string): number {
  const lower = title.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.includes(needle)) return 2;
  return 3;
}

/**
 * Access-scoped title/genre search across every accessible library's items,
 * ranked exact → prefix → substring and capped — a faithful mirror of GET
 * /api/search (routes/search.ts + lib/media-query.ts).
 */
function searchItems(
  all: MediaItem[],
  query: URLSearchParams,
): { results: MediaItem[]; query: string } {
  const trimmed = (query.get('q') ?? '').trim();
  if (trimmed === '') return { results: [], query: '' };
  const needle = trimmed.toLowerCase();
  const limit = Number(query.get('limit') ?? '20');
  const matched = all.filter(
    (item) =>
      item.title.toLowerCase().includes(needle) ||
      item.sortTitle.toLowerCase().includes(needle) ||
      item.genres.some((genre) => genre.toLowerCase().includes(needle)),
  );
  const ranked = matched
    .map((item, index) => ({ item, index, rank: searchRank(item.title, needle) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
  return { results: ranked, query: trimmed };
}

/**
 * Installs a stateful mock of the Aura API on global.fetch. Handlers mirror the
 * real server contracts (response shapes, status codes, error envelope).
 */
export function installMockApi(config: MockApiConfig = {}): MockApi {
  const refreshSpy = vi.fn();
  const state: MockApi['state'] = {
    publicSettings: {
      serverName: config.serverName ?? 'Test Server',
      registrationEnabled: config.registrationEnabled ?? true,
    },
    session: config.session ?? null,
    libraries: config.libraries ?? [],
    items: config.items ?? {},
    continueWatching: config.continueWatching ?? [],
    history: config.history ?? [],
    adminStats: config.adminStats ?? makeAdminStats(),
    details: config.details ?? {},
    password: config.password ?? 'current-pass-123',
    authUser: config.authUser ?? config.session ?? null,
    adminUsers: config.adminUsers ?? [],
    access: config.access ?? { users: [], libraries: [] },
    settings: { ...DEFAULT_ADMIN_SETTINGS, ...config.settings },
    tasks: config.tasks ?? [],
    activitySessions: config.activitySessions ?? [],
    scans: config.scans ?? {},
    decisions: config.decisions ?? {},
    qualities: config.qualities ?? makeQualities(),
    audioTracks: config.audioTracks ?? {},
    subtitles: config.subtitles ?? {},
    hlsSessionCounter: 0,
  };
  const conflictTaskId = config.taskRunConflictId;

  const handle = (
    url: string,
    init: RequestInit | undefined,
  ): { status: number; body?: unknown } => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url, 'http://localhost').pathname;
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;

    if (path === '/api/settings/public' && method === 'GET') {
      return { status: 200, body: state.publicSettings };
    }

    if (path === '/api/auth/refresh' && method === 'POST') {
      refreshSpy();
      if (state.session === null) {
        return { status: 401, body: err('UNAUTHORIZED', 'Invalid refresh token') };
      }
      return { status: 200, body: { user: state.session, accessToken: MOCK_ACCESS_TOKEN } };
    }

    if (path === '/api/auth/login' && method === 'POST') {
      if (body.password !== state.password) {
        return { status: 401, body: err('INVALID_CREDENTIALS', 'Invalid username or password') };
      }
      const user = state.authUser ?? makeUser({ username: String(body.username) });
      state.session = user;
      return { status: 200, body: { user, accessToken: MOCK_ACCESS_TOKEN } };
    }

    if (path === '/api/auth/register' && method === 'POST') {
      if (!state.publicSettings.registrationEnabled) {
        return { status: 403, body: err('REGISTRATION_DISABLED', 'Registration is disabled') };
      }
      const user = state.authUser ?? makeUser({ username: String(body.username), role: 'admin' });
      state.session = user;
      return { status: 201, body: { user, accessToken: MOCK_ACCESS_TOKEN } };
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      state.session = null;
      return { status: 204 };
    }

    if (path === '/api/libraries' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      return { status: 200, body: { libraries: state.libraries } };
    }

    const itemsMatch = /^\/api\/libraries\/([^/]+)\/items$/.exec(path);
    if (itemsMatch !== null && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const libraryId = decodeURIComponent(itemsMatch[1] ?? '');
      // Mirror the server's 404 cloak: an unknown / ungranted library id (one
      // not in the caller's accessible set) is indistinguishable from missing.
      if (!state.libraries.some((library) => library.id === libraryId)) {
        return { status: 404, body: err('NOT_FOUND', 'Library not found') };
      }
      const query = new URL(url, 'http://localhost').searchParams;
      return { status: 200, body: listItems(state.items[libraryId] ?? [], query) };
    }

    if (path === '/api/search' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const query = new URL(url, 'http://localhost').searchParams;
      // Scoped to accessible libraries (every returned library, as with browse).
      const all = state.libraries.flatMap((library) => state.items[library.id] ?? []);
      return { status: 200, body: searchItems(all, query) };
    }

    if (path === '/api/continue-watching' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const limit = Number(new URL(url, 'http://localhost').searchParams.get('limit') ?? '20');
      return { status: 200, body: { items: state.continueWatching.slice(0, limit) } };
    }

    // ---- Watch history -----------------------------------------------------
    if (path === '/api/history' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const query = new URL(url, 'http://localhost').searchParams;
      const limit = Number(query.get('limit') ?? '24');
      const page = Number(query.get('page') ?? '1');
      const total = state.history.length;
      const start = (page - 1) * limit;
      return {
        status: 200,
        body: { items: state.history.slice(start, start + limit), page, pageSize: limit, total },
      };
    }

    const historyDeleteMatch = /^\/api\/history\/([^/]+)$/.exec(path);
    if (historyDeleteMatch !== null && method === 'DELETE') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const itemId = decodeURIComponent(historyDeleteMatch[1] ?? '');
      state.history = state.history.filter((entry) => entry.item.id !== itemId);
      return { status: 204 };
    }

    // ---- Admin: server-wide stats ------------------------------------------
    if (path === '/api/admin/stats' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      return { status: 200, body: state.adminStats };
    }

    if (path === '/api/home/recently-added' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const limit = Number(new URL(url, 'http://localhost').searchParams.get('limit') ?? '20');
      // Cross-library feed: every accessible library's items, newest first.
      const all = state.libraries.flatMap((library) => state.items[library.id] ?? []);
      return { status: 200, body: { items: recentlyAdded(all, limit) } };
    }

    const recentMatch = /^\/api\/libraries\/([^/]+)\/recently-added$/.exec(path);
    if (recentMatch !== null && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const libraryId = decodeURIComponent(recentMatch[1] ?? '');
      // Same 404 cloak as the items route for an unknown / ungranted library.
      if (!state.libraries.some((library) => library.id === libraryId)) {
        return { status: 404, body: err('NOT_FOUND', 'Library not found') };
      }
      const limit = Number(new URL(url, 'http://localhost').searchParams.get('limit') ?? '20');
      return { status: 200, body: { items: recentlyAdded(state.items[libraryId] ?? [], limit) } };
    }

    // Item detail children: a show's seasons or a season's episodes.
    const childrenMatch = /^\/api\/items\/([^/]+)\/children$/.exec(path);
    if (childrenMatch !== null && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const id = decodeURIComponent(childrenMatch[1] ?? '');
      const detail = state.details[id];
      if (detail === undefined) return { status: 404, body: err('NOT_FOUND', 'Item not found') };
      const items = detail.item.type === 'show' ? detail.seasons : detail.episodes;
      return { status: 200, body: { items } };
    }

    // Explicit (un)mark, cascading to descendants for shows/seasons.
    const watchedMatch = /^\/api\/items\/([^/]+)\/watched$/.exec(path);
    if (watchedMatch !== null && method === 'PUT') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const id = decodeURIComponent(watchedMatch[1] ?? '');
      const watched = body.watched === true;
      const { type, affectedCount } = applyWatchedToDetails(state.details, id, watched);
      return { status: 200, body: { summary: { itemId: id, type, watched, affectedCount } } };
    }

    // Playback progress report (leaf items).
    const progressMatch = /^\/api\/items\/([^/]+)\/progress$/.exec(path);
    if (progressMatch !== null && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const id = decodeURIComponent(progressMatch[1] ?? '');
      const positionMs = typeof body.positionMs === 'number' ? body.positionMs : 0;
      return {
        status: 200,
        body: {
          state: {
            mediaItemId: id,
            positionMs: Math.max(0, positionMs),
            watched: false,
            watchedAt: null,
            playCount: 0,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };
    }

    // Single-item derived state.
    const stateMatch = /^\/api\/items\/([^/]+)\/state$/.exec(path);
    if (stateMatch !== null && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const id = decodeURIComponent(stateMatch[1] ?? '');
      const detail = state.details[id];
      const ws = detail?.item.watchState;
      return {
        status: 200,
        body: {
          state: {
            mediaItemId: id,
            type: detail?.item.type ?? 'movie',
            watched: ws?.watched ?? false,
            positionMs: ws?.positionMs ?? 0,
            playCount: 0,
            watchedAt: null,
            updatedAt: null,
            episodeCount: ws?.episodeCount ?? 0,
            watchedEpisodeCount: ws?.watchedEpisodeCount ?? 0,
            nextUnwatchedId: ws?.nextUnwatchedId ?? null,
          },
        },
      };
    }

    // Item detail: movie -> files; show -> seasons; season -> episodes. Single
    // path segment (the /children, /watched, ... variants matched above).
    const detailMatch = /^\/api\/items\/([^/]+)$/.exec(path);
    if (detailMatch !== null && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const id = decodeURIComponent(detailMatch[1] ?? '');
      const detail = state.details[id];
      if (detail === undefined) return { status: 404, body: err('NOT_FOUND', 'Item not found') };
      return { status: 200, body: detail };
    }

    if (path === '/api/users/me/password' && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      if (body.currentPassword !== state.password) {
        return { status: 401, body: err('INVALID_CREDENTIALS', 'Current password is incorrect') };
      }
      if (state.session !== null) {
        state.session = { ...state.session, mustChangePassword: false };
      }
      return { status: 204 };
    }

    // Self-service profile / preferences update. Mirrors the server's partial
    // PATCH: only provided fields change, `null` clears a nullable field, and
    // an invalid quality is a 400. Kept BEFORE the admin /users/:id match so
    // the static /me segment wins (as it does server-side).
    if (path === '/api/users/me' && method === 'PATCH') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      if (state.session === null) {
        return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      }
      if (
        'preferredQuality' in body &&
        body.preferredQuality !== null &&
        !(QUALITY_LADDER_NAMES as readonly unknown[]).includes(body.preferredQuality)
      ) {
        return { status: 400, body: err('VALIDATION', 'Invalid preferredQuality') };
      }
      const updated = { ...state.session };
      if ('email' in body) updated.email = (body.email as string | null) ?? null;
      if ('preferredQuality' in body) {
        updated.preferredQuality = (body.preferredQuality as string | null) ?? null;
      }
      if ('preferredSubtitleLanguage' in body) {
        updated.preferredSubtitleLanguage =
          (body.preferredSubtitleLanguage as string | null) ?? null;
      }
      if ('autoplayNextEpisode' in body) {
        updated.autoplayNextEpisode = Boolean(body.autoplayNextEpisode);
      }
      state.session = updated;
      state.authUser = updated;
      return { status: 200, body: { user: updated } };
    }

    // ---- Admin: users ------------------------------------------------------
    if (path === '/api/users' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      return { status: 200, body: { users: state.adminUsers } };
    }

    const userLibrariesMatch = /^\/api\/users\/([^/]+)\/libraries$/.exec(path);
    if (userLibrariesMatch !== null && method === 'PUT') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const userId = decodeURIComponent(userLibrariesMatch[1] ?? '');
      const requested = Array.isArray(body.libraryIds) ? (body.libraryIds as string[]) : [];
      const sorted = [...new Set(requested)].sort();
      const accessUser = state.access.users.find((entry) => entry.id === userId);
      if (accessUser !== undefined) accessUser.libraryIds = sorted;
      return { status: 200, body: { libraryIds: sorted } };
    }

    const userPasswordMatch = /^\/api\/users\/([^/]+)\/password$/.exec(path);
    if (userPasswordMatch !== null && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      if (typeof body.newPassword !== 'string' || body.newPassword === '') {
        return { status: 400, body: err('VALIDATION', 'newPassword is required') };
      }
      return { status: 204 };
    }

    const adminUserIdMatch = /^\/api\/users\/([^/]+)$/.exec(path);
    if (adminUserIdMatch !== null && (method === 'PATCH' || method === 'DELETE')) {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const userId = decodeURIComponent(adminUserIdMatch[1] ?? '');
      const target = state.adminUsers.find((entry) => entry.id === userId);
      if (target === undefined) return { status: 404, body: err('NOT_FOUND', 'User not found') };
      const enabledAdmins = state.adminUsers.filter(
        (entry) => entry.role === 'admin' && entry.isEnabled,
      ).length;

      if (method === 'DELETE') {
        if (target.role === 'admin' && target.isEnabled && enabledAdmins <= 1) {
          return {
            status: 409,
            body: err('LAST_ADMIN', 'Cannot delete the last enabled administrator'),
          };
        }
        if (state.session !== null && target.id === state.session.id) {
          return {
            status: 409,
            body: err('CANNOT_DELETE_SELF', 'You cannot delete your own account'),
          };
        }
        state.adminUsers = state.adminUsers.filter((entry) => entry.id !== userId);
        return { status: 204 };
      }

      const demoting = body.role === 'user' && target.role === 'admin';
      const disabling = body.isEnabled === false && target.isEnabled;
      if (
        (demoting || disabling) &&
        target.role === 'admin' &&
        target.isEnabled &&
        enabledAdmins <= 1
      ) {
        return {
          status: 409,
          body: err(
            'LAST_ADMIN',
            `Cannot ${demoting ? 'demote' : 'disable'} the last enabled administrator`,
          ),
        };
      }
      if (typeof body.role === 'string') target.role = body.role as AdminUser['role'];
      if (typeof body.isEnabled === 'boolean') target.isEnabled = body.isEnabled;
      if ('email' in body) target.email = (body.email as string | null) ?? null;
      if ('maxQuality' in body) {
        target.maxQuality = (body.maxQuality as AdminUser['maxQuality']) ?? null;
      }
      return { status: 200, body: { user: target } };
    }

    // ---- Admin: libraries CRUD + scan -------------------------------------
    if (path === '/api/libraries' && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      libraryCounter += 1;
      const library: Library = {
        id: `lib-new-${libraryCounter}`,
        name: String(body.name ?? ''),
        type: (body.type as LibraryType) ?? 'other',
        paths: Array.isArray(body.paths) ? (body.paths as string[]) : [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      state.libraries = [...state.libraries, library];
      return { status: 201, body: { library } };
    }

    const libScanMatch = /^\/api\/libraries\/([^/]+)\/scan$/.exec(path);
    if (libScanMatch !== null && (method === 'POST' || method === 'GET')) {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const libraryId = decodeURIComponent(libScanMatch[1] ?? '');
      if (!state.libraries.some((library) => library.id === libraryId)) {
        return { status: 404, body: err('NOT_FOUND', 'Library not found') };
      }
      if (method === 'POST') {
        if (state.scans[libraryId]?.status === 'scanning') {
          return {
            status: 409,
            body: err('SCAN_IN_PROGRESS', 'A scan is already running for this library'),
          };
        }
        state.scans[libraryId] = {
          libraryId,
          status: 'scanning',
          startedAt: '2026-03-01T00:00:00.000Z',
          finishedAt: null,
          stats: null,
          error: null,
        };
        return { status: 202, body: { started: true } };
      }
      const scan = state.scans[libraryId] ?? {
        libraryId,
        status: 'idle',
        startedAt: null,
        finishedAt: null,
        stats: null,
        error: null,
      };
      return { status: 200, body: { scan } };
    }

    const libAccessMatch = /^\/api\/libraries\/([^/]+)\/access$/.exec(path);
    if (libAccessMatch !== null && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const libraryId = decodeURIComponent(libAccessMatch[1] ?? '');
      const userId = String(body.userId ?? '');
      const accessUser = state.access.users.find((entry) => entry.id === userId);
      if (accessUser !== undefined && !accessUser.libraryIds.includes(libraryId)) {
        accessUser.libraryIds = [...accessUser.libraryIds, libraryId].sort();
      }
      return { status: 204 };
    }

    const libAccessRevokeMatch = /^\/api\/libraries\/([^/]+)\/access\/([^/]+)$/.exec(path);
    if (libAccessRevokeMatch !== null && method === 'DELETE') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const libraryId = decodeURIComponent(libAccessRevokeMatch[1] ?? '');
      const userId = decodeURIComponent(libAccessRevokeMatch[2] ?? '');
      const accessUser = state.access.users.find((entry) => entry.id === userId);
      if (accessUser !== undefined) {
        accessUser.libraryIds = accessUser.libraryIds.filter((id) => id !== libraryId);
      }
      return { status: 204 };
    }

    const libIdMatch = /^\/api\/libraries\/([^/]+)$/.exec(path);
    if (libIdMatch !== null && (method === 'PATCH' || method === 'DELETE')) {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const libraryId = decodeURIComponent(libIdMatch[1] ?? '');
      const existing = state.libraries.find((library) => library.id === libraryId);
      if (existing === undefined) {
        return { status: 404, body: err('NOT_FOUND', 'Library not found') };
      }
      if (method === 'DELETE') {
        state.libraries = state.libraries.filter((library) => library.id !== libraryId);
        return { status: 204 };
      }
      if (typeof body.name === 'string') existing.name = body.name;
      if (Array.isArray(body.paths)) existing.paths = body.paths as string[];
      existing.updatedAt = '2026-04-01T00:00:00.000Z';
      return { status: 200, body: { library: existing } };
    }

    if (path === '/api/scan' && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const results = state.libraries.map((library) => {
        const already = state.scans[library.id]?.status === 'scanning';
        if (!already) {
          state.scans[library.id] = {
            libraryId: library.id,
            status: 'scanning',
            startedAt: '2026-03-01T00:00:00.000Z',
            finishedAt: null,
            stats: null,
            error: null,
          };
        }
        return { libraryId: library.id, name: library.name, started: !already };
      });
      return { status: 202, body: { libraries: results } };
    }

    // ---- Admin: access matrix ---------------------------------------------
    if (path === '/api/access' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      return { status: 200, body: state.access };
    }

    // ---- Admin: settings ---------------------------------------------------
    if (path === '/api/settings' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      return { status: 200, body: { settings: state.settings } };
    }
    if (path === '/api/settings' && method === 'PATCH') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      state.settings = { ...state.settings, ...(body as Partial<AdminSettings>) };
      if (typeof body.serverName === 'string') state.publicSettings.serverName = body.serverName;
      if (typeof body.registrationEnabled === 'boolean') {
        state.publicSettings.registrationEnabled = body.registrationEnabled;
      }
      return { status: 200, body: { settings: state.settings } };
    }

    // ---- Admin: tasks ------------------------------------------------------
    if (path === '/api/tasks' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      return { status: 200, body: { tasks: state.tasks } };
    }
    const taskRunMatch = /^\/api\/tasks\/([^/]+)\/run$/.exec(path);
    if (taskRunMatch !== null && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const taskId = decodeURIComponent(taskRunMatch[1] ?? '');
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (task === undefined) return { status: 404, body: err('NOT_FOUND', 'Unknown task') };
      if (taskId === conflictTaskId || task.state === 'running') {
        return { status: 409, body: err('TASK_RUNNING', 'Task is already running') };
      }
      return { status: 202, body: { started: true, taskId } };
    }

    // ---- Admin: activity ---------------------------------------------------
    if (path === '/api/activity/sessions' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      if (config.activitySessionsError === true) {
        return { status: 500, body: err('INTERNAL', 'Internal server error') };
      }
      return { status: 200, body: { sessions: state.activitySessions } };
    }
    const activityKillMatch = /^\/api\/activity\/sessions\/([^/]+)$/.exec(path);
    if (activityKillMatch !== null && method === 'DELETE') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const sessionId = decodeURIComponent(activityKillMatch[1] ?? '');
      const existed = state.activitySessions.some((session) => session.id === sessionId);
      if (!existed) return { status: 404, body: err('NOT_FOUND', 'Unknown session') };
      state.activitySessions = state.activitySessions.filter((session) => session.id !== sessionId);
      return { status: 204 };
    }

    // ---- Playback / streaming -----------------------------------------------

    // GET /api/qualities — the current user's selectable rungs (JWT-authed).
    if (path === '/api/qualities' && method === 'GET') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      return { status: 200, body: state.qualities };
    }

    // POST /api/stream/decide/:mediaFileId — direct-vs-transcode (JWT-authed).
    const decideMatch = /^\/api\/stream\/decide\/([^/]+)$/.exec(path);
    if (decideMatch !== null && method === 'POST') {
      if (!hasBearer(init)) return { status: 401, body: err('UNAUTHORIZED', 'Missing token') };
      const mediaFileId = decodeURIComponent(decideMatch[1] ?? '');
      const decision = state.decisions[mediaFileId] ?? makeDirectDecision(mediaFileId);
      return { status: 200, body: decision };
    }

    // POST /api/stream/hls/:mediaFileId — start a session; DELETE — stop it.
    const hlsMatch = /^\/api\/stream\/hls\/([^/]+)$/.exec(path);
    if (hlsMatch !== null && method === 'POST') {
      const query = new URL(url, 'http://localhost').searchParams;
      state.hlsSessionCounter += 1;
      const sessionId = `session-${state.hlsSessionCounter}`;
      const token = query.get('token') ?? MOCK_STREAM_TOKEN;
      const audioTrack = query.get('audioTrack');
      const startOffset = query.get('startOffset');
      return {
        status: 200,
        body: {
          sessionId,
          playlistUrl: `/api/stream/hls/${sessionId}/index.m3u8?token=${token}`,
          quality: query.get('quality') ?? state.qualities.defaultQuality,
          audioTrackIndex: audioTrack !== null ? Number(audioTrack) : 0,
          downmixStereo: query.get('downmixStereo') === 'true',
          startOffsetSec: startOffset !== null ? Math.floor(Number(startOffset)) : 0,
        },
      };
    }
    if (hlsMatch !== null && method === 'DELETE') {
      return { status: 204 };
    }

    // GET /api/stream/audio/:mediaFileId — selectable audio tracks (token-authed).
    const audioMatch = /^\/api\/stream\/audio\/([^/]+)$/.exec(path);
    if (audioMatch !== null && method === 'GET') {
      const mediaFileId = decodeURIComponent(audioMatch[1] ?? '');
      return { status: 200, body: { mediaFileId, tracks: state.audioTracks[mediaFileId] ?? [] } };
    }

    // GET /api/stream/subtitles/:mediaFileId — subtitle tracks (token-authed).
    const subtitlesMatch = /^\/api\/stream\/subtitles\/([^/]+)$/.exec(path);
    if (subtitlesMatch !== null && method === 'GET') {
      const mediaFileId = decodeURIComponent(subtitlesMatch[1] ?? '');
      return { status: 200, body: { mediaFileId, tracks: state.subtitles[mediaFileId] ?? [] } };
    }

    return { status: 404, body: err('NOT_FOUND', `No mock for ${method} ${path}`) };
  };

  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;

    // Artwork endpoint: authenticated binary. Served here (not in `handle`,
    // which is JSON-only) so AuthImage can turn it into a blob object URL.
    if (/^\/api\/items\/[^/]+\/artwork\/(poster|backdrop)$/.test(path)) {
      if (!hasBearer(init)) {
        return Promise.resolve(
          new Response(JSON.stringify(err('UNAUTHORIZED', 'Missing token')), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      // Uint8Array body (not a Blob): a Blob constructed in the test realm is
      // rejected by the fetch Response in some Node versions, throwing on
      // construction. A typed-array body is portable and still yields .blob().
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'image/webp' },
        }),
      );
    }

    const { status, body } = handle(url, init);
    if (status === 204 || body === undefined) {
      return Promise.resolve(new Response(null, { status }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, refreshSpy, state };
}
