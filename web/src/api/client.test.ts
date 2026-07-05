import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  apiRequest,
  fetchAuthedObjectUrl,
  setAccessToken,
  setAuthBridge,
} from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function authHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('Authorization');
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

describe('apiRequest', () => {
  it('attaches the in-memory access token as a bearer header', async () => {
    setAccessToken('token-abc');
    const fetchMock = vi.fn<FetchImpl>(() => Promise.resolve(jsonResponse(200, { ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    const data = await apiRequest<{ ok: boolean }>('/libraries');

    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/libraries');
    expect(authHeader(init)).toBe('Bearer token-abc');
  });

  it('parses the standard error envelope into a typed ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(errorResponse(403, 'FORBIDDEN', 'Nope'))),
    );

    const error = await apiRequest('/libraries', { skipAuthRefresh: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe('FORBIDDEN');
    expect((error as ApiError).message).toBe('Nope');
  });

  it('on a 401 refreshes once and retries the original request with the new token', async () => {
    setAccessToken('stale');
    const fetchMock = vi.fn<FetchImpl>((url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { user: { id: 'u1' }, accessToken: 'fresh' }));
      }
      if (authHeader(init) === 'Bearer fresh') {
        return Promise.resolve(jsonResponse(200, { libraries: [] }));
      }
      return Promise.resolve(errorResponse(401, 'UNAUTHORIZED', 'expired'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const data = await apiRequest<{ libraries: unknown[] }>('/libraries');

    expect(data).toEqual({ libraries: [] });
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('clears auth (via the bridge) when the refresh fails', async () => {
    setAccessToken('stale');
    const onCleared = vi.fn();
    setAuthBridge({ onRefreshed: vi.fn(), onCleared });

    vi.stubGlobal(
      'fetch',
      vi.fn<FetchImpl>((url) => {
        if (String(url).endsWith('/auth/refresh')) {
          return Promise.resolve(errorResponse(401, 'UNAUTHORIZED', 'no session'));
        }
        return Promise.resolve(errorResponse(401, 'UNAUTHORIZED', 'expired'));
      }),
    );

    await expect(apiRequest('/libraries')).rejects.toBeInstanceOf(ApiError);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent 401s into a single refresh', async () => {
    setAccessToken('stale');
    setAuthBridge({ onRefreshed: vi.fn(), onCleared: vi.fn() });
    let refreshCount = 0;

    const fetchMock = vi.fn<FetchImpl>((url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        refreshCount += 1;
        return Promise.resolve(jsonResponse(200, { user: { id: 'u1' }, accessToken: 'fresh' }));
      }
      if (authHeader(init) === 'Bearer fresh') {
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      return Promise.resolve(errorResponse(401, 'UNAUTHORIZED', 'expired'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([
      apiRequest<{ ok: boolean }>('/libraries'),
      apiRequest<{ ok: boolean }>('/watch'),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(refreshCount).toBe(1);
  });
});

function imageResponse(status = 200): Response {
  // Typed-array body (not a Blob) for portable Response construction in CI.
  return new Response(new Uint8Array([1, 2, 3]), { status });
}

describe('fetchAuthedObjectUrl', () => {
  it('fetches a same-origin url with the bearer token and returns a blob object url', async () => {
    setAccessToken('img-token');
    const fetchMock = vi.fn<FetchImpl>(() => Promise.resolve(imageResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const url = await fetchAuthedObjectUrl('/api/items/m1/artwork/poster?size=w400');

    expect(url).toMatch(/^blob:/);
    const [calledUrl, init] = fetchMock.mock.calls[0] ?? [];
    // The url is used verbatim (already includes the /api base) — not re-prefixed.
    expect(calledUrl).toBe('/api/items/m1/artwork/poster?size=w400');
    expect(authHeader(init)).toBe('Bearer img-token');
    expect(init?.credentials).toBe('include');
  });

  it('refreshes once and retries on a 401', async () => {
    setAccessToken('stale');
    setAuthBridge({ onRefreshed: vi.fn(), onCleared: vi.fn() });
    const fetchMock = vi.fn<FetchImpl>((url, init) => {
      if (String(url).endsWith('/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { user: { id: 'u1' }, accessToken: 'fresh' }));
      }
      if (authHeader(init) === 'Bearer fresh') return Promise.resolve(imageResponse());
      return Promise.resolve(errorResponse(401, 'UNAUTHORIZED', 'expired'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = await fetchAuthedObjectUrl('/api/items/m1/artwork/poster');

    expect(url).toMatch(/^blob:/);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'))).toHaveLength(
      1,
    );
  });

  it('throws a typed ApiError when the resource is not available', async () => {
    setAccessToken('tok');
    vi.stubGlobal(
      'fetch',
      vi.fn<FetchImpl>(() => Promise.resolve(errorResponse(404, 'NOT_FOUND', 'gone'))),
    );

    const error = await fetchAuthedObjectUrl('/api/items/x/artwork/poster').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});
