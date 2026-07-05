import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Library, MediaItem, PrismaClient, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import {
  getContinueWatching,
  getItemState,
  getState,
  getStatesForItems,
  markTreeWatched,
  reportProgress,
  setWatched,
} from './watch-state.js';

// Unit tests for the watch-state service against a real temporary SQLite
// database. Users, libraries and media items are seeded straight through
// prisma; the service functions are exercised directly (access control is the
// routes' job and is covered in watch.test.ts).

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;

async function createUser(): Promise<User> {
  return prisma.user.create({
    data: { username: `user-${randomUUID().slice(0, 18)}`, passwordHash: 'hash' },
  });
}

async function createLibrary(type = 'movies'): Promise<Library> {
  return prisma.library.create({ data: { name: `Library ${randomUUID().slice(0, 8)}`, type } });
}

async function createMovie(libraryId: string, runtimeMs?: number): Promise<MediaItem> {
  return prisma.mediaItem.create({
    data: {
      libraryId,
      type: 'movie',
      title: 'Movie',
      sortTitle: 'movie',
      ...(runtimeMs === undefined ? {} : { runtimeMs }),
    },
  });
}

/** A show with `episodesPerSeason.length` seasons and the given episode counts. */
async function createShow(
  libraryId: string,
  episodesPerSeason: number[],
): Promise<{ show: MediaItem; seasons: MediaItem[]; episodes: MediaItem[][] }> {
  const show = await prisma.mediaItem.create({
    data: { libraryId, type: 'show', title: 'Show', sortTitle: 'show' },
  });
  const seasons: MediaItem[] = [];
  const episodes: MediaItem[][] = [];
  for (let s = 0; s < episodesPerSeason.length; s += 1) {
    const seasonNumber = s + 1;
    const season = await prisma.mediaItem.create({
      data: {
        libraryId,
        type: 'season',
        parentId: show.id,
        title: `Season ${seasonNumber}`,
        sortTitle: `season ${seasonNumber}`,
        seasonNumber,
      },
    });
    seasons.push(season);
    const seasonEpisodes: MediaItem[] = [];
    for (let e = 0; e < episodesPerSeason[s]!; e += 1) {
      const episodeNumber = e + 1;
      seasonEpisodes.push(
        await prisma.mediaItem.create({
          data: {
            libraryId,
            type: 'episode',
            parentId: season.id,
            title: `S${seasonNumber}E${episodeNumber}`,
            sortTitle: `s${seasonNumber}e${episodeNumber}`,
            seasonNumber,
            episodeNumber,
          },
        }),
      );
    }
    episodes.push(seasonEpisodes);
  }
  return { show, seasons, episodes };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-watch-state-test-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // A clean slate per test: cascade-delete removes items, grants and states.
  await prisma.watchState.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.libraryAccess.deleteMany();
  await prisma.library.deleteMany();
  await prisma.user.deleteMany();
});

describe('reportProgress', () => {
  it('upserts a position and updates it on the next report (resume)', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    const first = await reportProgress(user.id, movie.id, 5_000);
    expect(first.positionMs).toBe(5_000);
    expect(first.watched).toBe(false);
    expect(await prisma.watchState.count()).toBe(1);

    const second = await reportProgress(user.id, movie.id, 12_000);
    expect(second.positionMs).toBe(12_000);
    expect(await prisma.watchState.count()).toBe(1); // still one row (upsert)
  });

  it('auto-marks watched at >= 90% of the reported duration and bumps playCount', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    const state = await reportProgress(user.id, movie.id, 90_000, 100_000);
    expect(state.watched).toBe(true);
    expect(state.watchedAt).not.toBeNull();
    expect(state.playCount).toBe(1);
  });

  it('does NOT auto-mark watched at 80% of the duration', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    const state = await reportProgress(user.id, movie.id, 80_000, 100_000);
    expect(state.watched).toBe(false);
    expect(state.watchedAt).toBeNull();
    expect(state.playCount).toBe(0);
  });

  it('falls back to the item runtimeMs when no duration is passed', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id, 100_000);

    const state = await reportProgress(user.id, movie.id, 95_000);
    expect(state.watched).toBe(true);
  });

  it('clamps negative positions to 0', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    const state = await reportProgress(user.id, movie.id, -500);
    expect(state.positionMs).toBe(0);
  });

  it('keeps playCount at 1 across further progress once already watched', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    await reportProgress(user.id, movie.id, 95_000, 100_000); // -> watched, playCount 1
    const again = await reportProgress(user.id, movie.id, 98_000, 100_000);
    expect(again.watched).toBe(true);
    expect(again.playCount).toBe(1);
  });
});

describe('setWatched', () => {
  it('marks watched: resets position to 0, sets watchedAt and increments playCount', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);
    await reportProgress(user.id, movie.id, 30_000); // a resume position exists

    const state = await setWatched(user.id, movie.id, true);
    expect(state.watched).toBe(true);
    expect(state.positionMs).toBe(0);
    expect(state.watchedAt).not.toBeNull();
    expect(state.playCount).toBe(1);
  });

  it('increments playCount on each explicit mark-watched', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    await setWatched(user.id, movie.id, true);
    const second = await setWatched(user.id, movie.id, true);
    expect(second.playCount).toBe(2);
  });

  it('unmarks watched: clears watchedAt, sets watched false and position 0', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);
    await setWatched(user.id, movie.id, true);

    const state = await setWatched(user.id, movie.id, false);
    expect(state.watched).toBe(false);
    expect(state.watchedAt).toBeNull();
    expect(state.positionMs).toBe(0);
  });
});

describe('getState & getStatesForItems', () => {
  it('returns a zeroed view when no row exists', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    const state = await getState(user.id, movie.id);
    expect(state).toMatchObject({ positionMs: 0, watched: false, playCount: 0, watchedAt: null });
  });

  it('returns only ids that have a stored row', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const withRow = await createMovie(library.id);
    const withoutRow = await createMovie(library.id);
    await reportProgress(user.id, withRow.id, 1_000);

    const states = await getStatesForItems(user.id, [withRow.id, withoutRow.id]);
    expect(states.has(withRow.id)).toBe(true);
    expect(states.has(withoutRow.id)).toBe(false);
    expect(states.size).toBe(1);
  });
});

describe('markTreeWatched cascade & derived state', () => {
  it('marking a season watched cascades to all its episodes', async () => {
    const user = await createUser();
    const library = await createLibrary('tv');
    const { seasons, episodes } = await createShow(library.id, [3]);

    const summary = await markTreeWatched(user.id, seasons[0]!.id, true);
    expect(summary.affectedCount).toBe(3);

    for (const episode of episodes[0]!) {
      const state = await getState(user.id, episode.id);
      expect(state.watched).toBe(true);
      expect(state.positionMs).toBe(0);
      expect(state.playCount).toBe(1);
    }
  });

  it("derives a show's watched flag as true once every episode is watched", async () => {
    const user = await createUser();
    const library = await createLibrary('tv');
    const { show } = await createShow(library.id, [2, 2]);

    const before = await getItemState(user.id, show);
    expect(before.watched).toBe(false);
    expect(before.episodeCount).toBe(4);
    expect(before.watchedEpisodeCount).toBe(0);

    await markTreeWatched(user.id, show.id, true);

    const after = await getItemState(user.id, show);
    expect(after.watched).toBe(true);
    expect(after.watchedEpisodeCount).toBe(4);
    expect(after.nextUnwatchedId).toBeNull();
  });

  it('returns the first unwatched episode in order and advances as episodes are watched', async () => {
    const user = await createUser();
    const library = await createLibrary('tv');
    const { show, episodes } = await createShow(library.id, [2, 1]);
    const [s1e1, s1e2] = episodes[0]!;
    const [s2e1] = episodes[1]!;

    const initial = await getItemState(user.id, show);
    expect(initial.nextUnwatchedId).toBe(s1e1!.id);

    await setWatched(user.id, s1e1!.id, true);
    const afterFirst = await getItemState(user.id, show);
    expect(afterFirst.nextUnwatchedId).toBe(s1e2!.id);

    await setWatched(user.id, s1e2!.id, true);
    const afterSecond = await getItemState(user.id, show);
    expect(afterSecond.nextUnwatchedId).toBe(s2e1!.id);
  });

  it("surfaces a season's next-unwatched resume position", async () => {
    const user = await createUser();
    const library = await createLibrary('tv');
    const { seasons, episodes } = await createShow(library.id, [2]);
    await reportProgress(user.id, episodes[0]![0]!.id, 4_200);

    const state = await getItemState(user.id, seasons[0]!);
    expect(state.nextUnwatchedId).toBe(episodes[0]![0]!.id);
    expect(state.positionMs).toBe(4_200);
  });

  it('marking a movie watched only affects itself', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const movie = await createMovie(library.id);

    const summary = await markTreeWatched(user.id, movie.id, true);
    expect(summary.type).toBe('movie');
    expect(summary.affectedCount).toBe(1);
    expect((await getState(user.id, movie.id)).watched).toBe(true);
  });
});

describe('getContinueWatching', () => {
  it('lists in-progress items ordered by recency and excludes watched/zero-position', async () => {
    const user = await createUser();
    const library = await createLibrary();
    const inProgressOld = await createMovie(library.id);
    const inProgressNew = await createMovie(library.id);
    const finished = await createMovie(library.id);
    const untouched = await createMovie(library.id);

    await reportProgress(user.id, inProgressOld.id, 3_000);
    await sleep(5); // distinct updatedAt so recency ordering is deterministic
    await reportProgress(user.id, inProgressNew.id, 3_000);
    await setWatched(user.id, finished.id, true); // watched -> excluded
    // untouched has no row -> excluded

    const entries = await getContinueWatching(user.id, [library.id], 10);
    const ids = entries.map((entry) => entry.mediaItemId);
    expect(ids).toContain(inProgressOld.id);
    expect(ids).toContain(inProgressNew.id);
    expect(ids).not.toContain(finished.id);
    expect(ids).not.toContain(untouched.id);
    // Most-recently updated first.
    expect(ids[0]).toBe(inProgressNew.id);
  });

  it('excludes items in libraries not passed in and honours the limit', async () => {
    const user = await createUser();
    const permitted = await createLibrary();
    const other = await createLibrary();
    const permittedMovie = await createMovie(permitted.id);
    const otherMovie = await createMovie(other.id);
    await reportProgress(user.id, permittedMovie.id, 1_000);
    await reportProgress(user.id, otherMovie.id, 1_000);

    const entries = await getContinueWatching(user.id, [permitted.id], 10);
    expect(entries.map((entry) => entry.mediaItemId)).toEqual([permittedMovie.id]);

    const empty = await getContinueWatching(user.id, [], 10);
    expect(empty).toEqual([]);
  });
});
