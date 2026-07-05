import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backdropUrl,
  detectAuthStyle,
  NoApiKeyError,
  parseRetryAfterMs,
  parseTmdbUri,
  posterUrl,
  TmdbClient,
  TmdbHttpError,
  TmdbNetworkError,
  TmdbParseError,
  toTmdbUri,
} from './tmdb-client.js';

// All tests stub the global fetch — no live TMDB calls, ever.

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhYmMifQ.sig';

interface RecordedRequest {
  url: URL;
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Realistic /search/movie payload (with fields we do not model). */
function movieSearchBody(): unknown {
  return {
    page: 1,
    results: [
      {
        adult: false,
        backdrop_path: '/s3TBrRGB1iav7gFOCNx3H31MoES.jpg',
        genre_ids: [28, 878, 12],
        id: 27205,
        original_language: 'en',
        original_title: 'Inception',
        overview: 'Cobb, a skilled thief who commits corporate espionage...',
        popularity: 83.952,
        poster_path: '/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
        release_date: '2010-07-15',
        title: 'Inception',
        video: false,
        vote_average: 8.369,
        vote_count: 36104,
      },
    ],
    total_pages: 1,
    total_results: 1,
  };
}

/**
 * Stubs global fetch to answer every request with `responses` in order
 * (repeating the last one) and records each request's URL and headers.
 */
function stubFetch(...responses: Response[]) {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: new URL(String(input)),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve(response as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TmdbClient auth styles', () => {
  it('detects v3 keys vs v4 read tokens', () => {
    expect(detectAuthStyle(V3_KEY)).toBe('v3-query');
    expect(detectAuthStyle(V4_TOKEN)).toBe('v4-bearer');
  });

  it('sends a v3 key as the api_key query parameter, not a header', async () => {
    const { requests } = stubFetch(jsonResponse(movieSearchBody()));
    const client = new TmdbClient({ apiKey: V3_KEY });

    const results = await client.searchMovie('Inception', 2010);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(27205);
    const request = requests[0] as RecordedRequest;
    expect(request.url.origin).toBe('https://api.themoviedb.org');
    expect(request.url.pathname).toBe('/3/search/movie');
    expect(request.url.searchParams.get('api_key')).toBe(V3_KEY);
    expect(request.url.searchParams.get('query')).toBe('Inception');
    expect(request.url.searchParams.get('year')).toBe('2010');
    expect(request.headers['authorization']).toBeUndefined();
  });

  it('sends a v4 token as an Authorization bearer header, not a query param', async () => {
    const { requests } = stubFetch(jsonResponse(movieSearchBody()));
    const client = new TmdbClient({ apiKey: V4_TOKEN });

    await client.searchMovie('Inception');

    const request = requests[0] as RecordedRequest;
    expect(request.headers['authorization']).toBe(`Bearer ${V4_TOKEN}`);
    expect(request.url.searchParams.get('api_key')).toBeNull();
    expect(request.url.searchParams.has('year')).toBe(false);
  });

  it('throws NoApiKeyError for an empty/whitespace key without any network call', () => {
    const { fetchMock } = stubFetch(jsonResponse(movieSearchBody()));

    expect(() => new TmdbClient({ apiKey: '' })).toThrow(NoApiKeyError);
    expect(() => new TmdbClient({ apiKey: '   ' })).toThrow(NoApiKeyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('TmdbClient request building', () => {
  it('searchTv uses first_air_date_year for the year filter', async () => {
    const { requests } = stubFetch(jsonResponse({ page: 1, results: [] }));
    const client = new TmdbClient({ apiKey: V3_KEY });

    await client.searchTv('Breaking Bad', 2008);

    const request = requests[0] as RecordedRequest;
    expect(request.url.pathname).toBe('/3/search/tv');
    expect(request.url.searchParams.get('query')).toBe('Breaking Bad');
    expect(request.url.searchParams.get('first_air_date_year')).toBe('2008');
  });

  it('movieDetails appends release_dates,credits,external_ids', async () => {
    const { requests } = stubFetch(jsonResponse({ id: 27205, title: 'Inception' }));
    const client = new TmdbClient({ apiKey: V3_KEY });

    const details = await client.movieDetails(27205);

    expect(details.id).toBe(27205);
    const request = requests[0] as RecordedRequest;
    expect(request.url.pathname).toBe('/3/movie/27205');
    expect(request.url.searchParams.get('append_to_response')).toBe(
      'release_dates,credits,external_ids',
    );
  });

  it('tvDetails appends content_ratings,credits,external_ids', async () => {
    const { requests } = stubFetch(jsonResponse({ id: 1396, name: 'Breaking Bad' }));
    const client = new TmdbClient({ apiKey: V3_KEY });

    await client.tvDetails(1396);

    const request = requests[0] as RecordedRequest;
    expect(request.url.pathname).toBe('/3/tv/1396');
    expect(request.url.searchParams.get('append_to_response')).toBe(
      'content_ratings,credits,external_ids',
    );
  });

  it('seasonDetails hits /tv/:id/season/:n', async () => {
    const { requests } = stubFetch(
      jsonResponse({ id: 3572, season_number: 1, episodes: [] }),
    );
    const client = new TmdbClient({ apiKey: V3_KEY });

    const season = await client.seasonDetails(1396, 1);

    expect(season.season_number).toBe(1);
    expect((requests[0] as RecordedRequest).url.pathname).toBe('/3/tv/1396/season/1');
  });

  it('parses leniently: unknown extra fields are preserved, null fields tolerated', async () => {
    stubFetch(
      jsonResponse({
        id: 603,
        title: 'The Matrix',
        overview: null,
        tagline: null,
        runtime: 136,
        release_date: '1999-03-31',
        vote_average: 8.2,
        poster_path: null,
        backdrop_path: null,
        genres: [{ id: 28, name: 'Action', some_new_field: true }],
        brand_new_tmdb_field: { nested: 'yes' },
      }),
    );
    const client = new TmdbClient({ apiKey: V3_KEY });

    const details = await client.movieDetails(603);

    expect(details.title).toBe('The Matrix');
    expect(details.overview).toBeNull();
    expect(details.runtime).toBe(136);
    expect((details as Record<string, unknown>)['brand_new_tmdb_field']).toEqual({
      nested: 'yes',
    });
  });
});

describe('TmdbClient failure modes', () => {
  it('rejects with TmdbHttpError{status} on non-2xx, without retrying', async () => {
    const { fetchMock } = stubFetch(
      jsonResponse({ status_code: 34, status_message: 'not found' }, { status: 404 }),
    );
    const client = new TmdbClient({ apiKey: V3_KEY });

    const failure = await client.movieDetails(999999).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TmdbHttpError);
    expect((failure as TmdbHttpError).status).toBe(404);
    // The API key must never leak into error messages.
    expect((failure as TmdbHttpError).message).not.toContain(V3_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts after the timeout and rejects with a timed-out TmdbNetworkError', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new TmdbClient({ apiKey: V3_KEY, timeoutMs: 25 });

    const failure = await client.searchMovie('Inception').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TmdbNetworkError);
    expect((failure as TmdbNetworkError).timedOut).toBe(true);
  });

  it('wraps plain network failures in TmdbNetworkError (timedOut false)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const client = new TmdbClient({ apiKey: V3_KEY });

    const failure = await client.searchMovie('Inception').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TmdbNetworkError);
    expect((failure as TmdbNetworkError).timedOut).toBe(false);
  });

  it('rejects with TmdbParseError when a 2xx body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 }))),
    );
    const client = new TmdbClient({ apiKey: V3_KEY });

    await expect(client.searchMovie('Inception')).rejects.toBeInstanceOf(TmdbParseError);
  });

  it('rejects with TmdbParseError when required fields are missing', async () => {
    stubFetch(jsonResponse({ title: 'No id here' }));
    const client = new TmdbClient({ apiKey: V3_KEY });

    await expect(client.movieDetails(1)).rejects.toBeInstanceOf(TmdbParseError);
  });
});

describe('TmdbClient 429 handling', () => {
  it('retries once after a 429 and succeeds, waiting for Retry-After', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubFetch(
      jsonResponse({ status_code: 25, status_message: 'rate limited' }, {
        status: 429,
        headers: { 'retry-after': '2' },
      }),
      jsonResponse(movieSearchBody()),
    );
    const client = new TmdbClient({ apiKey: V3_KEY });

    const pending = client.searchMovie('Inception');
    // Flush microtasks: the first (429) response has been consumed.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Retry-After: 2 -> no retry before 2000ms have elapsed...
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ...and exactly one retry after it.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const results = await pending;
    expect(results[0]?.id).toBe(27205);
  });

  it('falls back to the configured backoff when 429 has no Retry-After', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubFetch(
      jsonResponse({ status_message: 'rate limited' }, { status: 429 }),
      jsonResponse(movieSearchBody()),
    );
    const client = new TmdbClient({ apiKey: V3_KEY, retryBackoffMs: 500 });

    const pending = client.searchMovie('Inception');
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(pending).resolves.toHaveLength(1);
  });

  it('gives up with TmdbHttpError(429) when the single retry is also rate limited', async () => {
    const { fetchMock } = stubFetch(
      jsonResponse({ status_message: 'rate limited' }, {
        status: 429,
        headers: { 'retry-after': '0' },
      }),
    );
    const client = new TmdbClient({ apiKey: V3_KEY });

    const failure = await client.searchMovie('Inception').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TmdbHttpError);
    expect((failure as TmdbHttpError).status).toBe(429);
    // Exactly one retry: two calls total.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('1.5')).toBe(1500);
  });

  it('parses HTTP-date values relative to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T12:00:00Z'));
    expect(parseRetryAfterMs('Sun, 05 Jul 2026 12:00:03 GMT')).toBe(3000);
    // Dates in the past clamp to 0 rather than going negative.
    expect(parseRetryAfterMs('Sun, 05 Jul 2026 11:59:00 GMT')).toBe(0);
  });

  it('returns undefined for absent or garbage values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
  });
});

describe('image URL helpers', () => {
  it('builds poster and backdrop URLs from size + path', () => {
    expect(posterUrl('/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg', 'w342')).toBe(
      'https://image.tmdb.org/t/p/w342/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg',
    );
    expect(posterUrl('/abc.jpg')).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
    expect(backdropUrl('/s3TBrRGB1iav7gFOCNx3H31MoES.jpg')).toBe(
      'https://image.tmdb.org/t/p/w1280/s3TBrRGB1iav7gFOCNx3H31MoES.jpg',
    );
    expect(backdropUrl('no-slash.jpg', 'original')).toBe(
      'https://image.tmdb.org/t/p/original/no-slash.jpg',
    );
  });

  it('round-trips the tmdb:<path> URI convention', () => {
    expect(toTmdbUri('/abc.jpg')).toBe('tmdb:/abc.jpg');
    expect(toTmdbUri('abc.jpg')).toBe('tmdb:/abc.jpg');
    expect(parseTmdbUri('tmdb:/abc.jpg')).toBe('/abc.jpg');
    expect(parseTmdbUri('/config/cache/abc.jpg')).toBeNull();
    expect(parseTmdbUri('https://example.com/x.jpg')).toBeNull();
  });
});
