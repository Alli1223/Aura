import { vi, type Mock } from 'vitest';

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

export interface MockApiConfig {
  serverName?: string;
  registrationEnabled?: boolean;
  /** The user a boot refresh restores. null → no session (logged out). */
  session?: AuthUser | null;
  libraries?: Library[];
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
    password: string;
    authUser: AuthUser | null;
  };
}

function err(code: string, message: string) {
  return { error: { code, message } };
}

function hasBearer(init: RequestInit | undefined): boolean {
  const auth = new Headers(init?.headers).get('Authorization');
  return auth !== null && auth.startsWith('Bearer ');
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
    const { status, body } = handle(String(input), init);
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
