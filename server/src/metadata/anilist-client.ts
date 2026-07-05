import { z } from 'zod';

import { parseRetryAfterMs } from './tmdb-client.js';

// Minimal typed AniList GraphQL client used by the anime metadata enrichment
// agent. fetch-based POST to the public AniList GraphQL endpoint — AniList
// requires NO API key (it is rate-limited to ~90 requests/minute and answers
// 429 with a Retry-After header, which we honour on a single retry).
//
// Responses are parsed with intentionally lenient zod schemas (loose objects,
// mostly-optional fields) so AniList adding fields never breaks us; only the
// fields we consume are validated. Every failure mode is a typed error:
// AnilistHttpError (non-2xx), AnilistNetworkError (network/timeout) or
// AnilistParseError (unusable response body). A single retry with backoff is
// performed on 429 rate limits, honouring the Retry-After header.

/** Public AniList GraphQL endpoint (no authentication required). */
export const ANILIST_API_URL = 'https://graphql.anilist.co';

/** Default time budget for a single AniList HTTP request. */
export const DEFAULT_ANILIST_TIMEOUT_MS = 10_000;

/** Fallback wait before the single 429 retry when Retry-After is absent. */
export const DEFAULT_ANILIST_RETRY_BACKOFF_MS = 1_000;

/** Upper bound on how long a Retry-After header may make us wait. */
const MAX_RETRY_DELAY_MS = 30_000;

/** Number of search candidates requested per query (matcher picks one). */
const DEFAULT_SEARCH_PER_PAGE = 10;

// ---------------------------------------------------------------------------
// anilist:<url> artwork URI convention
// ---------------------------------------------------------------------------

/**
 * MediaItem.posterPath/backdropPath values written by the anime enricher use
 * the scheme `anilist:<url>`, e.g.
 * "anilist:https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1.png".
 *
 * Unlike the `tmdb:<path>` convention (where only a bare image path is stored
 * and the base URL is reconstructed), AniList returns *fully-qualified* image
 * URLs, so the remainder after "anilist:" is the complete https URL exactly as
 * AniList returned it. Nothing is downloaded at enrichment time; the
 * artwork-cache feature must be extended to fetch these from the AniList CDN
 * host (s4.anilist.co) — it currently only fetches image.tmdb.org.
 */
export const ANILIST_URI_PREFIX = 'anilist:';

/** Wraps a full AniList image URL into an `anilist:` URI. */
export function toAnilistUri(url: string): string {
  return `${ANILIST_URI_PREFIX}${url}`;
}

/** Extracts the full image URL from an `anilist:` URI, or null for other URIs. */
export function parseAnilistUri(uri: string): string | null {
  if (!uri.startsWith(ANILIST_URI_PREFIX)) return null;
  return uri.slice(ANILIST_URI_PREFIX.length);
}

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

/**
 * Strips HTML from an AniList description. Even with `description(asHtml:
 * false)` AniList leaves `<br>` line breaks and the odd inline `<i>`/`<b>`
 * tag in, so we strip tags defensively and decode the handful of entities
 * AniList emits, keeping paragraph breaks readable.
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** An AniList response with a non-2xx status (after the single 429 retry). */
export class AnilistHttpError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;

  constructor(status: number) {
    super(`AniList request failed with status ${status}`);
    this.name = 'AnilistHttpError';
    this.status = status;
  }
}

/** fetch itself failed: DNS/connection errors or the request timing out. */
export class AnilistNetworkError extends Error {
  /** True when the failure was our own timeout abort. */
  readonly timedOut: boolean;

  constructor(message: string, options: { timedOut?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AnilistNetworkError';
    this.timedOut = options.timedOut ?? false;
  }
}

/** A 2xx response whose body was not JSON or missed required fields. */
export class AnilistParseError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AnilistParseError';
  }
}

/** True for any typed error the AniList client can throw. */
export function isAnilistClientError(
  err: unknown,
): err is AnilistHttpError | AnilistNetworkError | AnilistParseError {
  return (
    err instanceof AnilistHttpError ||
    err instanceof AnilistNetworkError ||
    err instanceof AnilistParseError
  );
}

// ---------------------------------------------------------------------------
// Response schemas (lenient: loose objects, unknown extra fields pass through)
// ---------------------------------------------------------------------------

const titleSchema = z.looseObject({
  romaji: z.string().nullish(),
  english: z.string().nullish(),
  native: z.string().nullish(),
});

const coverImageSchema = z.looseObject({
  large: z.string().nullish(),
  extraLarge: z.string().nullish(),
});

const fuzzyDateSchema = z.looseObject({
  year: z.number().nullish(),
  month: z.number().nullish(),
  day: z.number().nullish(),
});

const mediaSchema = z.looseObject({
  id: z.number(),
  title: titleSchema.nullish(),
  synonyms: z.array(z.string()).default([]),
  seasonYear: z.number().nullish(),
  /** One of TV, TV_SHORT, MOVIE, SPECIAL, OVA, ONA, MUSIC. */
  format: z.string().nullish(),
  episodes: z.number().nullish(),
  /** Runtime in minutes per episode (the full runtime for a film). */
  duration: z.number().nullish(),
  /** Weighted mean score as a 0-100 percentage. */
  averageScore: z.number().nullish(),
  popularity: z.number().nullish(),
  genres: z.array(z.string()).default([]),
  description: z.string().nullish(),
  coverImage: coverImageSchema.nullish(),
  bannerImage: z.string().nullish(),
  startDate: fuzzyDateSchema.nullish(),
});

const pageResponseSchema = z.looseObject({
  data: z.looseObject({
    Page: z.looseObject({
      media: z.array(mediaSchema).default([]),
    }),
  }),
});

const mediaResponseSchema = z.looseObject({
  data: z.looseObject({
    Media: mediaSchema,
  }),
});

export type AnilistMedia = z.infer<typeof mediaSchema>;

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

/** Shared selection set for a Media node. */
const MEDIA_FIELDS = `
  id
  title { romaji english native }
  synonyms
  seasonYear
  format
  episodes
  duration
  averageScore
  popularity
  genres
  description(asHtml: false)
  coverImage { large extraLarge }
  bannerImage
  startDate { year month day }
`;

const SEARCH_ANIME_QUERY = `
query ($search: String, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(type: ANIME, search: $search, sort: SEARCH_MATCH) {${MEDIA_FIELDS}}
  }
}`;

const ANIME_BY_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {${MEDIA_FIELDS}}
}`;

// ---------------------------------------------------------------------------
// Retry-After helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strips HTML from a media node's description in place, then returns it. */
function finaliseMedia(media: AnilistMedia): AnilistMedia {
  if (media.description != null) media.description = stripHtml(media.description);
  return media;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AnilistClientOptions {
  /** Per-request time budget; defaults to DEFAULT_ANILIST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Wait before the single 429 retry when Retry-After is missing. */
  retryBackoffMs?: number;
  /** Overrides the GraphQL endpoint (tests). */
  endpoint?: string;
  /** Overrides the global fetch (tests). */
  fetchImpl?: typeof fetch;
}

export class AnilistClient {
  private readonly timeoutMs: number;
  private readonly retryBackoffMs: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: AnilistClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ANILIST_TIMEOUT_MS;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_ANILIST_RETRY_BACKOFF_MS;
    this.endpoint = options.endpoint ?? ANILIST_API_URL;
    this.fetchImpl = options.fetchImpl;
  }

  /** Searches anime by title, returning a small page of ranked candidates. */
  async searchAnime(title: string, perPage = DEFAULT_SEARCH_PER_PAGE): Promise<AnilistMedia[]> {
    const body = await this.request(
      SEARCH_ANIME_QUERY,
      { search: title, perPage },
      pageResponseSchema,
    );
    return body.data.Page.media.map(finaliseMedia);
  }

  /** Fetches a single anime by its AniList id. */
  async animeById(id: number): Promise<AnilistMedia> {
    const body = await this.request(ANIME_BY_ID_QUERY, { id }, mediaResponseSchema);
    return finaliseMedia(body.data.Media);
  }

  // -------------------------------------------------------------------------

  /** One fetch attempt with the timeout enforced via AbortController. */
  private async fetchOnce(query: string, variables: Record<string, unknown>): Promise<Response> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await doFetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new AnilistNetworkError(`AniList request timed out after ${this.timeoutMs}ms`, {
          timedOut: true,
          cause,
        });
      }
      throw new AnilistNetworkError('AniList request failed (network error)', { cause });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response = await this.fetchOnce(query, variables);
    if (response.status === 429) {
      // Single retry on rate limiting, honouring Retry-After when present.
      const delayMs = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(Math.min(delayMs ?? this.retryBackoffMs, MAX_RETRY_DELAY_MS));
      response = await this.fetchOnce(query, variables);
    }
    if (!response.ok) throw new AnilistHttpError(response.status);

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new AnilistParseError('AniList returned a non-JSON body', { cause });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AnilistParseError(
        `AniList response had an unexpected shape: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }
}
