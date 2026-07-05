import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';

// Integration tests for the search API against a real temporary SQLite database.
// The fixture spans three libraries: two granted to an ordinary user and one it
// has NO grant for. The ungranted library holds an item whose title is an exact
// match for a query the user runs, proving access scoping is enforced in the
// query (not just the UI): a user only ever sees granted libraries, while the
// first-registered admin sees everything.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface Session {
  id: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface SerializedItem {
  id: string;
  libraryId: string;
  type: string;
  title: string;
  year: number | null;
  genres: string[];
  posterUrl: string | null;
  backdropUrl: string | null;
}
interface SearchBody {
  results: SerializedItem[];
  query: string;
}

/** Every id the fixture graph produces, keyed for readable assertions. */
interface Fixture {
  movieLibId: string;
  tvLibId: string;
  ungrantedLibId: string;
  alpha: string; // "Alpha"          exact match for "alpha"
  alphabet: string; // "Alphabet"    prefix match, higher rating
  alphaCode: string; // "The Alpha Code" substring match only
  bravo: string; // "Bravo"          genre "Documentary" (title has no "documentary")
  gammaShow: string; // show "Gamma", genre "Sci-Fi"
  gammaEpisode: string; // "Gamma S1E1" — must never surface (not top-level)
  forbiddenAlpha: string; // "Alpha" in the ungranted library
}

let fx: Fixture;
let admin: Session; // first registered user → admin, sees every library
let user: Session; // granted movie + tv, NOT the ungranted library

function auth(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

function get(url: string, token?: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: auth(token) });
}

function search(query: string, token?: string): Promise<LightMyRequestResponse> {
  return get(`/api/search?q=${encodeURIComponent(query)}`, token);
}

function titles(res: LightMyRequestResponse): string[] {
  return res.json<SearchBody>().results.map((item) => item.title);
}

async function registerUser(): Promise<Session> {
  const username = `user-${randomUUID().slice(0, 18)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string }; accessToken: string }>();
  return { id: body.user.id, accessToken: body.accessToken };
}

/** Builds the fixture graph and grants `user` the movie + tv libraries only. */
async function seed(): Promise<Fixture> {
  const movieLib = await prisma.library.create({ data: { name: 'Movies', type: 'movies' } });
  const tvLib = await prisma.library.create({ data: { name: 'Shows', type: 'tv' } });
  const ungrantedLib = await prisma.library.create({ data: { name: 'Vault', type: 'other' } });

  const t = (n: number): Date => new Date(Date.UTC(2026, 0, n));

  const alpha = await prisma.mediaItem.create({
    data: {
      libraryId: movieLib.id,
      type: 'movie',
      title: 'Alpha',
      sortTitle: 'alpha',
      year: 2001,
      communityRating: 5,
      posterPath: 'tmdb:/alpha-poster.jpg',
      backdropPath: 'anilist:https://s4.anilist.co/alpha-back.jpg',
      addedAt: t(1),
      genres: { connectOrCreate: [{ where: { name: 'Action' }, create: { name: 'Action' } }] },
    },
  });
  const alphabet = await prisma.mediaItem.create({
    data: {
      libraryId: movieLib.id,
      type: 'movie',
      title: 'Alphabet',
      sortTitle: 'alphabet',
      year: 2015,
      communityRating: 9, // higher rating than Alpha, but a prefix (not exact)
      addedAt: t(2),
      genres: { connectOrCreate: [{ where: { name: 'Action' }, create: { name: 'Action' } }] },
    },
  });
  const alphaCode = await prisma.mediaItem.create({
    data: {
      libraryId: movieLib.id,
      type: 'movie',
      title: 'The Alpha Code',
      sortTitle: 'alpha code, the',
      year: 2018,
      communityRating: 8,
      addedAt: t(3),
      genres: {
        connectOrCreate: [{ where: { name: 'Thriller' }, create: { name: 'Thriller' } }],
      },
    },
  });
  const bravo = await prisma.mediaItem.create({
    data: {
      libraryId: movieLib.id,
      type: 'movie',
      title: 'Bravo',
      sortTitle: 'bravo',
      year: 1999,
      communityRating: 7,
      addedAt: t(4),
      genres: {
        connectOrCreate: [{ where: { name: 'Documentary' }, create: { name: 'Documentary' } }],
      },
    },
  });

  const gammaShow = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'show',
      title: 'Gamma',
      sortTitle: 'gamma',
      addedAt: t(5),
      genres: { connectOrCreate: [{ where: { name: 'Sci-Fi' }, create: { name: 'Sci-Fi' } }] },
    },
  });
  const gammaSeason = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'season',
      parentId: gammaShow.id,
      title: 'Season 1',
      sortTitle: 'season 1',
      seasonNumber: 1,
    },
  });
  const gammaEpisode = await prisma.mediaItem.create({
    data: {
      libraryId: tvLib.id,
      type: 'episode',
      parentId: gammaSeason.id,
      title: 'Gamma S1E1',
      sortTitle: 'gamma s1e1',
      seasonNumber: 1,
      episodeNumber: 1,
    },
  });

  // The forbidden item: an exact-title "Alpha" in a library the user cannot see.
  const forbiddenAlpha = await prisma.mediaItem.create({
    data: {
      libraryId: ungrantedLib.id,
      type: 'movie',
      title: 'Alpha',
      sortTitle: 'alpha',
      year: 1990,
      communityRating: 10, // the best-rated Alpha of all — still must never leak
      addedAt: t(6),
    },
  });

  await prisma.libraryAccess.createMany({
    data: [
      { userId: user.id, libraryId: movieLib.id },
      { userId: user.id, libraryId: tvLib.id },
    ],
  });

  return {
    movieLibId: movieLib.id,
    tvLibId: tvLib.id,
    ungrantedLibId: ungrantedLib.id,
    alpha: alpha.id,
    alphabet: alphabet.id,
    alphaCode: alphaCode.id,
    bravo: bravo.id,
    gammaShow: gammaShow.id,
    gammaEpisode: gammaEpisode.id,
    forbiddenAlpha: forbiddenAlpha.id,
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-search-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  prisma = getPrisma();
  app = buildApp();
  await app.ready();

  // The first registered user becomes admin (first-run setup); `user` is an
  // ordinary account whose grants the access checks actually gate.
  admin = await registerUser();
  user = await registerUser();
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.watchState.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.libraryAccess.deleteMany();
  await prisma.library.deleteMany();
  await prisma.genre.deleteMany();
  fx = await seed();
});

describe('authentication', () => {
  it('rejects an unauthenticated search with 401 UNAUTHORIZED', async () => {
    const res = await search('alpha');
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/search — matching & ranking', () => {
  it('matches by title substring and ranks exact > prefix > substring', async () => {
    const res = await search('alpha', user.accessToken);
    expect(res.statusCode).toBe(200);
    // Alpha (exact) → Alphabet (prefix, rating 9) → The Alpha Code (substring).
    // The exact match wins despite Alphabet's higher communityRating.
    expect(titles(res)).toEqual(['Alpha', 'Alphabet', 'The Alpha Code']);
    expect(res.json<SearchBody>().results.map((i) => i.id)).toEqual([
      fx.alpha,
      fx.alphabet,
      fx.alphaCode,
    ]);
  });

  it('is case-insensitive', async () => {
    expect(titles(await search('ALPHABET', user.accessToken))).toEqual(['Alphabet']);
    expect(titles(await search('gAmMa', user.accessToken))).toEqual(['Gamma']);
  });

  it('matches by genre name when the title does not contain the query', async () => {
    const res = await search('Documentary', user.accessToken);
    expect(titles(res)).toEqual(['Bravo']);
  });

  it('surfaces the parent show, never an episode (only top-level items)', async () => {
    const res = await search('Gamma', user.accessToken);
    const results = res.json<SearchBody>().results;
    expect(results.map((i) => i.id)).toEqual([fx.gammaShow]);
    expect(results.every((i) => i.type === 'show' || i.type === 'movie')).toBe(true);
    // The episode "Gamma S1E1" matches on title but must not be returned.
    expect(titles(await search('S1E1', user.accessToken))).toEqual([]);
  });

  it('echoes the trimmed query and treats surrounding whitespace as the same search', async () => {
    const res = await search('  alpha  ', user.accessToken);
    expect(res.json<SearchBody>().query).toBe('alpha');
    expect(titles(res)).toEqual(['Alpha', 'Alphabet', 'The Alpha Code']);
  });
});

describe('GET /api/search — access scoping', () => {
  it('returns ONLY items from granted libraries (ungranted never appears, even on exact title)', async () => {
    const res = await search('alpha', user.accessToken);
    const ids = res.json<SearchBody>().results.map((i) => i.id);
    // Three granted "alpha" matches, and the forbidden exact-title "Alpha" is absent.
    expect(ids).toEqual([fx.alpha, fx.alphabet, fx.alphaCode]);
    expect(ids).not.toContain(fx.forbiddenAlpha);
  });

  it('lets an admin search across every library, including the ungranted one', async () => {
    const res = await search('alpha', admin.accessToken);
    const ids = res.json<SearchBody>().results.map((i) => i.id);
    expect(ids).toContain(fx.forbiddenAlpha);
    // Two exact "Alpha" titles (both granted + ungranted), plus prefix + substring.
    expect(ids).toHaveLength(4);
  });

  it('returns nothing for a user with no library grants', async () => {
    await prisma.libraryAccess.deleteMany({ where: { userId: user.id } });
    const res = await search('alpha', user.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchBody>().results).toEqual([]);
  });
});

describe('GET /api/search — empty query & limits', () => {
  it('returns empty results (no error) for an empty query', async () => {
    const res = await get('/api/search?q=', user.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchBody>()).toEqual({ results: [], query: '' });
  });

  it('returns empty results for a whitespace-only query', async () => {
    const res = await get('/api/search?q=%20%20%20', user.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchBody>().results).toEqual([]);
  });

  it('returns empty results when q is absent entirely', async () => {
    const res = await get('/api/search', user.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchBody>().results).toEqual([]);
  });

  it('caps the result count at the requested limit', async () => {
    const res = await get('/api/search?q=alpha&limit=2', user.accessToken);
    // The top two by ranking: Alpha (exact) then Alphabet (prefix).
    expect(titles(res)).toEqual(['Alpha', 'Alphabet']);
  });

  it('rejects a limit over the cap with 400 VALIDATION', async () => {
    const res = await get('/api/search?q=alpha&limit=51', user.accessToken);
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('rejects a non-positive limit with 400 VALIDATION', async () => {
    const res = await get('/api/search?q=alpha&limit=0', user.accessToken);
    expect(res.statusCode).toBe(400);
    expect(res.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

describe('GET /api/search — serialized shape', () => {
  it('exposes the artwork route (not raw uris) and leaks no filesystem paths', async () => {
    const res = await search('Alpha', user.accessToken);
    const alpha = res.json<SearchBody>().results.find((i) => i.id === fx.alpha)!;
    expect(alpha.posterUrl).toBe(`/api/items/${fx.alpha}/artwork/poster`);
    expect(alpha.backdropUrl).toBe(`/api/items/${fx.alpha}/artwork/backdrop`);
    expect(alpha.genres).toEqual(['Action']);

    const body = res.body;
    expect(body).not.toContain('/media/');
    expect(body).not.toContain('tmdb:');
    expect(body).not.toContain('anilist:');
  });
});
