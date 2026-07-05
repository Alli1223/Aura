import { vi, type Mock } from 'vitest';

import type { DetailEpisode, ItemDetail, MediaFileInfo } from '../api/detail';
import type { ContinueWatchingEntry } from '../api/home';
import type { MediaItem } from '../api/media';
import type { AuthUser, Library, LibraryType, PublicSettings } from '../api/types';

/** Fixed token the mock server hands back so tests can assert bearer headers. */
export const MOCK_ACCESS_TOKEN = 'access-token';

export function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    username: 'alli',
    email: null,
    role: 'user',
    isEnabled: true,
    mustChangePassword: false,
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
  /** Item detail payloads keyed by item id, served by GET /items/:id. */
  details?: Record<string, ItemDetail>;
  /** Current password accepted by login / change-password. */
  password?: string;
  /** User returned by a successful login/register (defaults to the session). */
  authUser?: AuthUser;
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
    details: Record<string, ItemDetail>;
    password: string;
    authUser: AuthUser | null;
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
function searchItems(all: MediaItem[], query: URLSearchParams): { results: MediaItem[]; query: string } {
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
    details: config.details ?? {},
    password: config.password ?? 'current-pass-123',
    authUser: config.authUser ?? config.session ?? null,
  };

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
