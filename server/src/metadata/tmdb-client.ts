import { z } from 'zod';

// Minimal typed TMDB (The Movie Database) v3 API client used by the metadata
// enrichment agent. fetch-based, no SDK dependency. Authentication accepts
// either credential style TMDB hands out:
//
//   - v3 API key (32-char hex) — sent as the `api_key` query parameter.
//   - v4 read access token (a JWT, always starting with "eyJ") — sent as an
//     `Authorization: Bearer` header.
//
// Responses are parsed with intentionally lenient zod schemas (loose objects,
// mostly-optional fields) so TMDB adding fields never breaks us; only the
// fields we consume are validated. Every failure mode is a typed error:
// NoApiKeyError, TmdbHttpError (non-2xx), TmdbNetworkError (network/timeout)
// or TmdbParseError (unusable response body). A single retry with backoff is
// performed on 429 rate limits, honouring the Retry-After header.

export const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

/** Default time budget for a single TMDB HTTP request. */
export const DEFAULT_TMDB_TIMEOUT_MS = 10_000;

/** Fallback wait before the single 429 retry when Retry-After is absent. */
export const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/** Upper bound on how long a Retry-After header may make us wait. */
const MAX_RETRY_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// tmdb:<path> artwork URI convention
// ---------------------------------------------------------------------------

/**
 * MediaItem.posterPath/backdropPath values written by the TMDB enrichers use
 * the scheme `tmdb:<imagePath>`, e.g. "tmdb:/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg".
 * The remainder after "tmdb:" is the raw TMDB image path (leading slash
 * included, exactly as returned by the API). The artwork-cache feature later
 * resolves these URIs to real URLs via posterUrl()/backdropUrl() and replaces
 * them with cached files; nothing is downloaded at enrichment time.
 */
export const TMDB_URI_PREFIX = 'tmdb:';

/** Wraps a TMDB image path (e.g. "/abc.jpg") into a `tmdb:` URI. */
export function toTmdbUri(imagePath: string): string {
  const normalised = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
  return `${TMDB_URI_PREFIX}${normalised}`;
}

/** Extracts the TMDB image path from a `tmdb:` URI, or null for other URIs. */
export function parseTmdbUri(uri: string): string | null {
  if (!uri.startsWith(TMDB_URI_PREFIX)) return null;
  const imagePath = uri.slice(TMDB_URI_PREFIX.length);
  return imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
}

// ---------------------------------------------------------------------------
// Image URL helpers
// ---------------------------------------------------------------------------

export type TmdbPosterSize = 'w92' | 'w154' | 'w185' | 'w342' | 'w500' | 'w780' | 'original';
export type TmdbBackdropSize = 'w300' | 'w780' | 'w1280' | 'original';

function imageUrl(imagePath: string, size: string): string {
  const normalised = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
  return `${TMDB_IMAGE_BASE_URL}${size}${normalised}`;
}

/** Full https URL for a poster path, e.g. posterUrl("/abc.jpg", "w500"). */
export function posterUrl(imagePath: string, size: TmdbPosterSize = 'w500'): string {
  return imageUrl(imagePath, size);
}

/** Full https URL for a backdrop path. */
export function backdropUrl(imagePath: string, size: TmdbBackdropSize = 'w1280'): string {
  return imageUrl(imagePath, size);
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when a TmdbClient is constructed without an API key. */
export class NoApiKeyError extends Error {
  constructor(message = 'No TMDB API key is configured (settings key "tmdbApiKey")') {
    super(message);
    this.name = 'NoApiKeyError';
  }
}

/** A TMDB response with a non-2xx status (after the single 429 retry). */
export class TmdbHttpError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Request path without query string (never contains the API key). */
  readonly endpoint: string;

  constructor(status: number, endpoint: string) {
    super(`TMDB request failed with status ${status} for ${endpoint}`);
    this.name = 'TmdbHttpError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** fetch itself failed: DNS/connection errors or the request timing out. */
export class TmdbNetworkError extends Error {
  /** True when the failure was our own timeout abort. */
  readonly timedOut: boolean;

  constructor(message: string, options: { timedOut?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TmdbNetworkError';
    this.timedOut = options.timedOut ?? false;
  }
}

/** A 2xx response whose body was not JSON or missed required fields. */
export class TmdbParseError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TmdbParseError';
    this.endpoint = endpoint;
  }
}

/** True for any typed error the TMDB client can throw. */
export function isTmdbClientError(
  err: unknown,
): err is NoApiKeyError | TmdbHttpError | TmdbNetworkError | TmdbParseError {
  return (
    err instanceof NoApiKeyError ||
    err instanceof TmdbHttpError ||
    err instanceof TmdbNetworkError ||
    err instanceof TmdbParseError
  );
}

// ---------------------------------------------------------------------------
// Response schemas (lenient: loose objects, unknown extra fields pass through)
// ---------------------------------------------------------------------------

const genreSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
});

const movieSearchResultSchema = z.looseObject({
  id: z.number(),
  title: z.string(),
  original_title: z.string().nullish(),
  release_date: z.string().nullish(),
  popularity: z.number().nullish(),
  vote_count: z.number().nullish(),
  vote_average: z.number().nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
});

const tvSearchResultSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  original_name: z.string().nullish(),
  first_air_date: z.string().nullish(),
  popularity: z.number().nullish(),
  vote_count: z.number().nullish(),
  vote_average: z.number().nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
});

const movieSearchResponseSchema = z.looseObject({
  page: z.number().nullish(),
  results: z.array(movieSearchResultSchema).default([]),
  total_results: z.number().nullish(),
});

const tvSearchResponseSchema = z.looseObject({
  page: z.number().nullish(),
  results: z.array(tvSearchResultSchema).default([]),
  total_results: z.number().nullish(),
});

const castMemberSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  character: z.string().nullish(),
  order: z.number().nullish(),
  profile_path: z.string().nullish(),
});

const crewMemberSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  job: z.string().nullish(),
  department: z.string().nullish(),
});

const creditsSchema = z.looseObject({
  cast: z.array(castMemberSchema).default([]),
  crew: z.array(crewMemberSchema).default([]),
});

const externalIdsSchema = z.looseObject({
  imdb_id: z.string().nullish(),
  tvdb_id: z.number().nullish(),
});

const releaseDatesSchema = z.looseObject({
  results: z
    .array(
      z.looseObject({
        iso_3166_1: z.string(),
        release_dates: z
          .array(z.looseObject({ certification: z.string().nullish() }))
          .default([]),
      }),
    )
    .default([]),
});

const contentRatingsSchema = z.looseObject({
  results: z
    .array(z.looseObject({ iso_3166_1: z.string(), rating: z.string().nullish() }))
    .default([]),
});

const movieDetailsSchema = z.looseObject({
  id: z.number(),
  title: z.string(),
  original_title: z.string().nullish(),
  overview: z.string().nullish(),
  tagline: z.string().nullish(),
  release_date: z.string().nullish(),
  /** Runtime in minutes. */
  runtime: z.number().nullish(),
  vote_average: z.number().nullish(),
  vote_count: z.number().nullish(),
  imdb_id: z.string().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  genres: z.array(genreSchema).default([]),
  release_dates: releaseDatesSchema.nullish(),
  credits: creditsSchema.nullish(),
  external_ids: externalIdsSchema.nullish(),
});

const seasonSummarySchema = z.looseObject({
  id: z.number(),
  season_number: z.number(),
  name: z.string().nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  episode_count: z.number().nullish(),
  air_date: z.string().nullish(),
});

const tvDetailsSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  original_name: z.string().nullish(),
  overview: z.string().nullish(),
  tagline: z.string().nullish(),
  first_air_date: z.string().nullish(),
  /** Typical episode runtimes in minutes (often a single entry, may be empty). */
  episode_run_time: z.array(z.number()).default([]),
  vote_average: z.number().nullish(),
  vote_count: z.number().nullish(),
  poster_path: z.string().nullish(),
  backdrop_path: z.string().nullish(),
  number_of_seasons: z.number().nullish(),
  genres: z.array(genreSchema).default([]),
  seasons: z.array(seasonSummarySchema).default([]),
  content_ratings: contentRatingsSchema.nullish(),
  credits: creditsSchema.nullish(),
  external_ids: externalIdsSchema.nullish(),
});

const episodeSchema = z.looseObject({
  id: z.number(),
  episode_number: z.number(),
  season_number: z.number().nullish(),
  name: z.string().nullish(),
  overview: z.string().nullish(),
  still_path: z.string().nullish(),
  air_date: z.string().nullish(),
  /** Runtime in minutes. */
  runtime: z.number().nullish(),
  vote_average: z.number().nullish(),
});

const seasonDetailsSchema = z.looseObject({
  id: z.number(),
  season_number: z.number(),
  name: z.string().nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  air_date: z.string().nullish(),
  episodes: z.array(episodeSchema).default([]),
});

export type TmdbMovieSearchResult = z.infer<typeof movieSearchResultSchema>;
export type TmdbTvSearchResult = z.infer<typeof tvSearchResultSchema>;
export type TmdbMovieDetails = z.infer<typeof movieDetailsSchema>;
export type TmdbTvDetails = z.infer<typeof tvDetailsSchema>;
export type TmdbSeasonDetails = z.infer<typeof seasonDetailsSchema>;
export type TmdbEpisode = z.infer<typeof episodeSchema>;

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

/**
 * Parses an HTTP Retry-After header value into a delay in milliseconds.
 * Supports both the delta-seconds ("2") and HTTP-date forms. Returns
 * undefined for absent or unparseable values.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TmdbClientOptions {
  /** A TMDB v3 API key or v4 read access token (see detectAuthStyle). */
  apiKey: string;
  /** Per-request time budget; defaults to DEFAULT_TMDB_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Wait before the single 429 retry when Retry-After is missing. */
  retryBackoffMs?: number;
  /** Overrides the global fetch (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * v4 read access tokens are JWTs and always start with "eyJ" (base64 of
 * '{"'); everything else is treated as a v3 API key.
 */
export function detectAuthStyle(apiKey: string): 'v3-query' | 'v4-bearer' {
  return apiKey.startsWith('eyJ') ? 'v4-bearer' : 'v3-query';
}

export class TmdbClient {
  private readonly apiKey: string;
  private readonly authStyle: 'v3-query' | 'v4-bearer';
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly fetchImpl: typeof fetch | undefined;

  /** @throws NoApiKeyError when `apiKey` is empty or whitespace-only. */
  constructor(options: TmdbClientOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey === '') throw new NoApiKeyError();
    this.apiKey = apiKey;
    this.authStyle = detectAuthStyle(apiKey);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TMDB_TIMEOUT_MS;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl;
  }

  /** Searches movies by title, optionally constrained to a release year. */
  async searchMovie(title: string, year?: number): Promise<TmdbMovieSearchResult[]> {
    const params: Record<string, string> = { query: title, include_adult: 'false' };
    if (year !== undefined) params['year'] = String(year);
    const body = await this.request('/search/movie', params, movieSearchResponseSchema);
    return body.results;
  }

  /** Searches TV shows by title, optionally constrained to a first-air year. */
  async searchTv(title: string, year?: number): Promise<TmdbTvSearchResult[]> {
    const params: Record<string, string> = { query: title, include_adult: 'false' };
    if (year !== undefined) params['first_air_date_year'] = String(year);
    const body = await this.request('/search/tv', params, tvSearchResponseSchema);
    return body.results;
  }

  /** Movie details with release_dates, credits and external_ids appended. */
  async movieDetails(id: number): Promise<TmdbMovieDetails> {
    return this.request(
      `/movie/${id}`,
      { append_to_response: 'release_dates,credits,external_ids' },
      movieDetailsSchema,
    );
  }

  /** TV details with content_ratings, credits and external_ids appended. */
  async tvDetails(id: number): Promise<TmdbTvDetails> {
    return this.request(
      `/tv/${id}`,
      { append_to_response: 'content_ratings,credits,external_ids' },
      tvDetailsSchema,
    );
  }

  /** One season of a show, including its episode list. */
  async seasonDetails(tvId: number, seasonNumber: number): Promise<TmdbSeasonDetails> {
    return this.request(`/tv/${tvId}/season/${seasonNumber}`, {}, seasonDetailsSchema);
  }

  // -------------------------------------------------------------------------

  private buildUrl(endpoint: string, params: Record<string, string>): URL {
    const url = new URL(`${TMDB_API_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (this.authStyle === 'v3-query') url.searchParams.set('api_key', this.apiKey);
    return url;
  }

  /** One fetch attempt with the timeout enforced via AbortController. */
  private async fetchOnce(url: URL): Promise<Response> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.authStyle === 'v4-bearer') headers['authorization'] = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await doFetch(url, { headers, signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new TmdbNetworkError(`TMDB request timed out after ${this.timeoutMs}ms`, {
          timedOut: true,
          cause,
        });
      }
      throw new TmdbNetworkError('TMDB request failed (network error)', { cause });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(
    endpoint: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = this.buildUrl(endpoint, params);

    let response = await this.fetchOnce(url);
    if (response.status === 429) {
      // Single retry on rate limiting, honouring Retry-After when present.
      const delayMs = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(Math.min(delayMs ?? this.retryBackoffMs, MAX_RETRY_DELAY_MS));
      response = await this.fetchOnce(url);
    }
    if (!response.ok) throw new TmdbHttpError(response.status, endpoint);

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new TmdbParseError(endpoint, `TMDB returned non-JSON body for ${endpoint}`, { cause });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new TmdbParseError(
        endpoint,
        `TMDB response for ${endpoint} had an unexpected shape: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }
}
