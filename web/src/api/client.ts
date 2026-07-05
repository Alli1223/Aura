import type { AuthSession } from './types';

/** Base path for all API calls. In dev, Vite proxies /api to the server. */
export const API_BASE = '/api';

/** Typed error parsed from the server's `{ error: { code, message } }` shape. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** True for a plain network failure (server unreachable), not an HTTP error. */
export class NetworkError extends Error {
  constructor(message = 'Unable to reach the server') {
    super(message);
    this.name = 'NetworkError';
  }
}

// ---- In-memory access token -------------------------------------------------
// The token lives only in memory (module scope); the long-lived session is the
// httpOnly refresh cookie. A page reload drops the token and boot re-refreshes.

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

// ---- Auth bridge ------------------------------------------------------------
// Lets a background (silent) refresh push its result into the AuthContext and
// signal a hard logout when the refresh fails, without the client importing React.

export interface AuthBridge {
  /** A silent refresh rotated the token; keep app state in sync. */
  onRefreshed(session: AuthSession): void;
  /** Refresh failed — the session is gone; clear auth and bounce to /login. */
  onCleared(): void;
}

let authBridge: AuthBridge | null = null;

export function setAuthBridge(bridge: AuthBridge | null): void {
  authBridge = bridge;
}

// ---- Request options --------------------------------------------------------

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** JSON-serialisable request body (sent as application/json). */
  body?: unknown;
  /**
   * Skip the silent-refresh-on-401 dance. Used by the auth endpoints
   * themselves (login/register/refresh) so a bad-credentials 401 is not
   * mistaken for an expired session.
   */
  skipAuthRefresh?: boolean;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'UNKNOWN';
  let message = response.statusText || 'Request failed';
  try {
    const data = (await response.json()) as { error?: { code?: string; message?: string } };
    if (data.error?.code) code = data.error.code;
    if (data.error?.message) message = data.error.message;
  } catch {
    // Non-JSON body; keep the status-based defaults.
  }
  return new ApiError(response.status, code, message);
}

async function parseBody<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }
  const text = await response.text();
  if (text === '') return undefined as T;
  return JSON.parse(text) as T;
}

function buildInit(options: RequestOptions, token: string | null): RequestInit {
  // `skipAuthRefresh` is a client-only flag; it lands in `rest` and is harmless
  // to fetch (unknown RequestInit keys are ignored).
  const { body, headers: rawHeaders, ...rest } = options;
  const headers = new Headers(rawHeaders);
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const init: RequestInit = {
    ...rest,
    headers,
    // Always send/receive the httpOnly refresh cookie.
    credentials: 'include',
  };
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }
  return init;
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  return rawFetchAbsolute(`${API_BASE}${path}`, init);
}

/** Like rawFetch but the url is taken verbatim (already includes the API base). */
async function rawFetchAbsolute(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new NetworkError();
  }
}

// ---- Single-flight refresh --------------------------------------------------
// Concurrent 401s must trigger exactly one POST /auth/refresh. All callers share
// the same in-flight promise; it is cleared once settled so the next 401 can
// refresh again.

let refreshPromise: Promise<AuthSession> | null = null;

async function performRefresh(): Promise<AuthSession> {
  const response = await rawFetch('/auth/refresh', buildInit({ method: 'POST' }, null));
  if (!response.ok) {
    throw await parseError(response);
  }
  const session = await parseBody<AuthSession>(response);
  accessToken = session.accessToken;
  authBridge?.onRefreshed(session);
  return session;
}

/**
 * Refreshes the session, de-duplicating concurrent callers so a burst of 401s
 * triggers exactly one POST /auth/refresh. Exposed so the AuthContext can
 * attempt a session restore on boot.
 */
export function refreshSession(): Promise<AuthSession> {
  if (refreshPromise === null) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// ---- Core request -----------------------------------------------------------

/**
 * Runs `doFetch` with the current access token and, on a 401, performs a single
 * silent refresh and retries once. Shared by the JSON request path and the
 * authenticated blob-URL fetch so both get identical session handling.
 */
async function withAuthRetry(
  doFetch: (token: string | null) => Promise<Response>,
  skipAuthRefresh: boolean,
): Promise<Response> {
  let response = await doFetch(accessToken);

  if (response.status === 401 && !skipAuthRefresh) {
    let session: AuthSession;
    try {
      session = await refreshSession();
    } catch {
      // Refresh failed: the session is unrecoverable. Clear and surface a 401.
      authBridge?.onCleared();
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired');
    }
    response = await doFetch(session.accessToken);
  }

  return response;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await withAuthRetry(
    (token) => rawFetch(path, buildInit(options, token)),
    options.skipAuthRefresh ?? false,
  );

  if (!response.ok) {
    throw await parseError(response);
  }
  return parseBody<T>(response);
}

/**
 * Fetches a same-origin, authenticated resource (e.g. an artwork endpoint that
 * requires a Bearer token, which a plain `<img src>` cannot supply) and returns
 * a blob object URL suitable for an `<img>`. Reuses the access token + the
 * single-flight silent refresh. The caller MUST revoke the returned URL with
 * `URL.revokeObjectURL` when done to avoid leaking memory.
 *
 * `url` is taken verbatim (it already starts with the `/api` base, as the
 * server's posterUrl/backdropUrl fields do).
 */
export async function fetchAuthedObjectUrl(url: string): Promise<string> {
  const response = await withAuthRetry((token) => {
    const headers = new Headers();
    if (token !== null) headers.set('Authorization', `Bearer ${token}`);
    return rawFetchAbsolute(url, { headers, credentials: 'include' });
  }, false);

  if (!response.ok) {
    throw await parseError(response);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
