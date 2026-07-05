import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnilistClient,
  AnilistHttpError,
  AnilistNetworkError,
  AnilistParseError,
  parseAnilistUri,
  stripHtml,
  toAnilistUri,
} from './anilist-client.js';

// All tests stub the global fetch — no live AniList calls, ever.

interface RecordedRequest {
  url: URL;
  method: string | undefined;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Realistic Page.media search payload (with fields we do not model). */
function cowboyBebopSearchBody(): unknown {
  return {
    data: {
      Page: {
        media: [
          {
            id: 1,
            title: { romaji: 'Cowboy Bebop', english: 'Cowboy Bebop', native: 'カウボーイビバップ' },
            synonyms: ['カウボーイビバップ'],
            seasonYear: 1998,
            format: 'TV',
            episodes: 26,
            duration: 24,
            averageScore: 86,
            popularity: 400000,
            genres: ['Action', 'Adventure', 'Sci-Fi'],
            description:
              'In the year 2071, humanity has colonized several of the planets.<br><br>' +
              '<i>Enter</i> the bounty hunters &amp; their exploits.',
            coverImage: {
              large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-CXtrrkMpJ8Zq.png',
              extraLarge:
                'https://s4.anilist.co/file/anilistcdn/media/anime/cover/extraLarge/bx1-CXtrrkMpJ8Zq.png',
            },
            bannerImage: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/1-T3PJUjFJyRwg.jpg',
            startDate: { year: 1998, month: 4, day: 3 },
            brand_new_anilist_field: { nested: 'yes' },
          },
        ],
      },
    },
  };
}

/**
 * Stubs global fetch to answer every request with `responses` in order
 * (repeating the last one) and records each request's URL, method and parsed
 * JSON body.
 */
function stubFetch(...responses: Response[]) {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: new URL(String(input)),
      method: init?.method,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: JSON.parse(String(init?.body ?? '{}')) as RecordedRequest['body'],
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

describe('AnilistClient request building', () => {
  it('POSTs a GraphQL query + variables as JSON', async () => {
    const { requests } = stubFetch(jsonResponse(cowboyBebopSearchBody()));
    const client = new AnilistClient();

    const results = await client.searchAnime('Cowboy Bebop');

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(1);
    const request = requests[0] as RecordedRequest;
    expect(request.url.origin).toBe('https://graphql.anilist.co');
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body.query).toContain('media(type: ANIME');
    expect(request.body.query).toContain('description(asHtml: false)');
    expect(request.body.variables).toMatchObject({ search: 'Cowboy Bebop', perPage: 10 });
  });

  it('animeById sends the id variable and reads Media', async () => {
    const { requests } = stubFetch(
      jsonResponse({
        data: {
          Media: {
            id: 21,
            title: { romaji: 'One Piece', english: 'One Piece', native: 'ONE PIECE' },
            synonyms: [],
            seasonYear: 1999,
            genres: ['Action'],
          },
        },
      }),
    );
    const client = new AnilistClient();

    const media = await client.animeById(21);

    expect(media.id).toBe(21);
    const request = requests[0] as RecordedRequest;
    expect(request.body.query).toContain('Media(id: $id, type: ANIME)');
    expect(request.body.variables).toMatchObject({ id: 21 });
  });

  it('parses leniently: unknown extra fields survive, null fields tolerated', async () => {
    stubFetch(
      jsonResponse({
        data: {
          Page: {
            media: [
              {
                id: 5,
                title: { romaji: 'Trigun', english: null, native: 'トライガン' },
                synonyms: [],
                seasonYear: null,
                averageScore: null,
                genres: ['Action'],
                description: null,
                unexpected_field: true,
              },
            ],
          },
        },
      }),
    );
    const client = new AnilistClient();

    const [media] = await client.searchAnime('Trigun');

    expect(media?.title?.english).toBeNull();
    expect(media?.seasonYear).toBeNull();
    expect((media as Record<string, unknown>)['unexpected_field']).toBe(true);
  });
});

describe('AnilistClient description handling', () => {
  it('strips HTML tags and decodes entities from the description', async () => {
    stubFetch(jsonResponse(cowboyBebopSearchBody()));
    const client = new AnilistClient();

    const [media] = await client.searchAnime('Cowboy Bebop');

    expect(media?.description).not.toContain('<');
    expect(media?.description).not.toContain('>');
    expect(media?.description).toContain('bounty hunters & their exploits');
    // <br><br> becomes a paragraph break.
    expect(media?.description).toContain('planets.\n\nEnter the bounty hunters');
  });
});

describe('AnilistClient failure modes', () => {
  it('rejects with AnilistHttpError{status} on non-2xx, without retrying', async () => {
    const { fetchMock } = stubFetch(jsonResponse({ errors: [{ message: 'Not Found' }] }, { status: 404 }));
    const client = new AnilistClient();

    const failure = await client.animeById(999_999).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AnilistHttpError);
    expect((failure as AnilistHttpError).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts after the timeout and rejects with a timed-out AnilistNetworkError', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason ?? new Error('aborted')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new AnilistClient({ timeoutMs: 25 });

    const failure = await client.searchAnime('Cowboy Bebop').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AnilistNetworkError);
    expect((failure as AnilistNetworkError).timedOut).toBe(true);
  });

  it('wraps plain network failures in AnilistNetworkError (timedOut false)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const client = new AnilistClient();

    const failure = await client.searchAnime('Cowboy Bebop').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AnilistNetworkError);
    expect((failure as AnilistNetworkError).timedOut).toBe(false);
  });

  it('rejects with AnilistParseError when a 2xx body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 }))),
    );
    const client = new AnilistClient();

    await expect(client.searchAnime('Cowboy Bebop')).rejects.toBeInstanceOf(AnilistParseError);
  });

  it('rejects with AnilistParseError when required fields are missing (e.g. GraphQL errors)', async () => {
    stubFetch(jsonResponse({ errors: [{ message: 'Internal Server Error' }], data: null }));
    const client = new AnilistClient();

    await expect(client.searchAnime('Cowboy Bebop')).rejects.toBeInstanceOf(AnilistParseError);
  });
});

describe('AnilistClient 429 handling', () => {
  it('retries once after a 429 and succeeds, waiting for Retry-After', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubFetch(
      jsonResponse({ errors: [{ message: 'Too Many Requests' }] }, {
        status: 429,
        headers: { 'retry-after': '2' },
      }),
      jsonResponse(cowboyBebopSearchBody()),
    );
    const client = new AnilistClient();

    const pending = client.searchAnime('Cowboy Bebop');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const results = await pending;
    expect(results[0]?.id).toBe(1);
  });

  it('falls back to the configured backoff when 429 has no Retry-After', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubFetch(
      jsonResponse({ errors: [{ message: 'rate limited' }] }, { status: 429 }),
      jsonResponse(cowboyBebopSearchBody()),
    );
    const client = new AnilistClient({ retryBackoffMs: 500 });

    const pending = client.searchAnime('Cowboy Bebop');
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(pending).resolves.toHaveLength(1);
  });

  it('gives up with AnilistHttpError(429) when the single retry is also rate limited', async () => {
    const { fetchMock } = stubFetch(
      jsonResponse({ errors: [{ message: 'rate limited' }] }, {
        status: 429,
        headers: { 'retry-after': '0' },
      }),
    );
    const client = new AnilistClient();

    const failure = await client.searchAnime('Cowboy Bebop').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(AnilistHttpError);
    expect((failure as AnilistHttpError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('stripHtml', () => {
  it('removes tags, decodes entities and keeps paragraph breaks', () => {
    expect(stripHtml('<b>Bold</b> &amp; <i>italic</i>')).toBe('Bold & italic');
    expect(stripHtml('line one<br>line two')).toBe('line one\nline two');
    expect(stripHtml('a<br><br>b')).toBe('a\n\nb');
    expect(stripHtml('&lt;tag&gt; &quot;q&quot; &#039;a&#039;')).toBe('<tag> "q" \'a\'');
  });
});

describe('anilist:<url> URI convention', () => {
  it('round-trips full AniList CDN URLs after the prefix', () => {
    const url = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.png';
    expect(toAnilistUri(url)).toBe(`anilist:${url}`);
    expect(parseAnilistUri(`anilist:${url}`)).toBe(url);
    expect(parseAnilistUri('tmdb:/abc.jpg')).toBeNull();
    expect(parseAnilistUri('/config/cache/abc.jpg')).toBeNull();
  });
});
