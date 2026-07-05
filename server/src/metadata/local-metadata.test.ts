import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveArtwork } from './artwork-cache.js';
import {
  findLocalArtwork,
  findNfoForFile,
  findShowNfo,
  parseNfo,
  readLocalMetadata,
} from './local-metadata.js';

// Unit tests for the local sidecar metadata module: NFO parsing (well-formed,
// malformed, legacy id forms, conversions, sanitisation) and path-safe
// discovery of .nfo + artwork sidecars inside temporary media roots. No
// network, no database — just real files on disk.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aura-local-meta-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function touch(filePath: string, content = ''): Promise<string> {
  await writeFile(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// parseNfo
// ---------------------------------------------------------------------------

const MOVIE_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Inception</title>
  <originaltitle>Inception (original)</originaltitle>
  <year>2010</year>
  <plot>A thief who steals corporate secrets.</plot>
  <tagline>Your mind is the scene of the crime.</tagline>
  <runtime>148</runtime>
  <rating>8.8</rating>
  <mpaa>Rated PG-13</mpaa>
  <genre>Action</genre>
  <genre>Sci-Fi</genre>
  <uniqueid type="tmdb" default="true">27205</uniqueid>
  <uniqueid type="imdb">tt1375666</uniqueid>
  <premiered>2010-07-16</premiered>
</movie>`;

describe('parseNfo — movie', () => {
  it('extracts every supported field with correct conversions', () => {
    const nfo = parseNfo(MOVIE_NFO);
    expect(nfo).not.toBeNull();
    expect(nfo?.title).toBe('Inception');
    expect(nfo?.originalTitle).toBe('Inception (original)');
    expect(nfo?.year).toBe(2010);
    expect(nfo?.overview).toBe('A thief who steals corporate secrets.');
    expect(nfo?.tagline).toBe('Your mind is the scene of the crime.');
    // runtime is minutes -> milliseconds.
    expect(nfo?.runtimeMs).toBe(148 * 60_000);
    expect(nfo?.communityRating).toBe(8.8);
    // "Rated " prefix stripped.
    expect(nfo?.contentRating).toBe('PG-13');
    expect(nfo?.genres).toEqual(['Action', 'Sci-Fi']);
    expect(nfo?.tmdbId).toBe(27205);
    expect(nfo?.imdbId).toBe('tt1375666');
  });
});

describe('parseNfo — tvshow & episode', () => {
  it('parses a tvshow root and derives the year from <premiered>', () => {
    const nfo = parseNfo(
      `<tvshow><title>Cowboy Bebop</title><plot>Bounty hunters.</plot><premiered>1998-04-03</premiered></tvshow>`,
    );
    expect(nfo?.title).toBe('Cowboy Bebop');
    expect(nfo?.overview).toBe('Bounty hunters.');
    expect(nfo?.year).toBe(1998);
  });

  it('parses an episodedetails root and derives the year from <aired>', () => {
    const nfo = parseNfo(
      `<episodedetails><title>Asteroid Blues</title><plot>Pilot.</plot><aired>1998-04-03</aired><runtime>24</runtime></episodedetails>`,
    );
    expect(nfo?.title).toBe('Asteroid Blues');
    expect(nfo?.year).toBe(1998);
    expect(nfo?.runtimeMs).toBe(24 * 60_000);
  });
});

describe('parseNfo — tolerance', () => {
  it('tolerates a leading and trailing non-XML URL line', () => {
    const nfo = parseNfo(
      `https://www.themoviedb.org/movie/27205\n${MOVIE_NFO}\nhttps://imdb.com/title/tt1375666/`,
    );
    expect(nfo?.title).toBe('Inception');
    expect(nfo?.tmdbId).toBe(27205);
  });

  it('returns null for a URL-only .nfo (no markup)', () => {
    expect(parseNfo('https://www.themoviedb.org/movie/27205')).toBeNull();
  });

  it('returns null for text with no usable NFO markup', () => {
    expect(parseNfo('')).toBeNull();
    expect(parseNfo('   ')).toBeNull();
    // A recognisable-but-foreign root is not an NFO.
    expect(parseNfo('<html><body>not an nfo</body></html>')).toBeNull();
  });

  it('never throws on malformed XML (tolerated: object or null)', () => {
    for (const bad of ['<movie><title>Broken</title', '<movie', '<<<>>>', '<movie></tvshow>']) {
      expect(() => parseNfo(bad)).not.toThrow();
    }
  });
});

describe('parseNfo — id forms', () => {
  it('reads legacy <tmdbid>/<imdbid> tags', () => {
    const nfo = parseNfo(`<movie><title>The Matrix</title><tmdbid>603</tmdbid><imdbid>tt0133093</imdbid></movie>`);
    expect(nfo?.tmdbId).toBe(603);
    expect(nfo?.imdbId).toBe('tt0133093');
  });

  it('interprets a legacy <id> as imdb when it looks like "tt…"', () => {
    const nfo = parseNfo(`<movie><title>X</title><id>tt0133093</id></movie>`);
    expect(nfo?.imdbId).toBe('tt0133093');
    expect(nfo?.tmdbId).toBeUndefined();
  });

  it('interprets a purely numeric legacy <id> as tmdb', () => {
    const nfo = parseNfo(`<movie><title>X</title><id>603</id></movie>`);
    expect(nfo?.tmdbId).toBe(603);
    expect(nfo?.imdbId).toBeUndefined();
  });

  it('prefers an explicit uniqueid over legacy tags', () => {
    const nfo = parseNfo(
      `<movie><title>X</title><uniqueid type="tmdb">111</uniqueid><tmdbid>999</tmdbid></movie>`,
    );
    expect(nfo?.tmdbId).toBe(111);
  });
});

describe('parseNfo — genres, caps & sanitisation', () => {
  it('handles a single <genre> tag', () => {
    const nfo = parseNfo(`<movie><title>X</title><genre>Drama</genre></movie>`);
    expect(nfo?.genres).toEqual(['Drama']);
  });

  it('caps an over-long title to 500 chars', () => {
    const long = 'a'.repeat(600);
    const nfo = parseNfo(`<movie><title>${long}</title></movie>`);
    expect(nfo?.title).toHaveLength(500);
  });

  it('strips control characters from field values', () => {
    const bell = String.fromCharCode(7);
    const unitSep = String.fromCharCode(31);
    const nfo = parseNfo(`<movie><title>In${unitSep}cep${bell}tion</title></movie>`);
    expect(nfo?.title).toBe('Inception');
  });

  it('reads the modern <ratings><rating><value> container', () => {
    const nfo = parseNfo(
      `<movie><title>X</title><ratings><rating name="themoviedb" default="true" max="10"><value>7.5</value></rating></ratings></movie>`,
    );
    expect(nfo?.communityRating).toBe(7.5);
  });
});

// ---------------------------------------------------------------------------
// Sidecar discovery
// ---------------------------------------------------------------------------

describe('findNfoForFile', () => {
  it('finds <basename>.nfo next to a movie', async () => {
    const dir = path.join(root, 'Inception (2010)');
    await mkdir(dir, { recursive: true });
    const video = path.join(dir, 'Inception (2010).mkv');
    await touch(video);
    const nfo = await touch(path.join(dir, 'Inception (2010).nfo'), MOVIE_NFO);
    expect(await findNfoForFile(video, 'movie', [root])).toBe(nfo);
  });

  it('falls back to movie.nfo for a movie', async () => {
    const dir = path.join(root, 'Inception (2010)');
    await mkdir(dir, { recursive: true });
    const video = path.join(dir, 'Inception (2010).mkv');
    await touch(video);
    const nfo = await touch(path.join(dir, 'movie.nfo'), MOVIE_NFO);
    expect(await findNfoForFile(video, 'movie', [root])).toBe(nfo);
  });

  it('finds <basename>.nfo for an episode but does not use movie.nfo', async () => {
    const dir = path.join(root, 'Show', 'Season 01');
    await mkdir(dir, { recursive: true });
    const video = path.join(dir, 'Show - S01E01.mkv');
    await touch(video);
    await touch(path.join(dir, 'movie.nfo'), MOVIE_NFO);
    expect(await findNfoForFile(video, 'episode', [root])).toBeNull();
    const nfo = await touch(path.join(dir, 'Show - S01E01.nfo'), '<episodedetails><title>Ep</title></episodedetails>');
    expect(await findNfoForFile(video, 'episode', [root])).toBe(nfo);
  });

  it('returns null when the video sits outside every media root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'aura-outside-'));
    try {
      const video = path.join(outside, 'movie.mkv');
      await touch(video);
      await touch(path.join(outside, 'movie.nfo'), MOVIE_NFO);
      expect(await findNfoForFile(video, 'movie', [root])).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('findShowNfo', () => {
  it('finds tvshow.nfo in the show folder', async () => {
    const dir = path.join(root, 'Cowboy Bebop');
    await mkdir(dir, { recursive: true });
    const nfo = await touch(path.join(dir, 'tvshow.nfo'), '<tvshow><title>Cowboy Bebop</title></tvshow>');
    expect(await findShowNfo(dir, [root])).toBe(nfo);
  });

  it('returns null when there is no tvshow.nfo', async () => {
    const dir = path.join(root, 'Cowboy Bebop');
    await mkdir(dir, { recursive: true });
    expect(await findShowNfo(dir, [root])).toBeNull();
  });
});

describe('findLocalArtwork', () => {
  const basename = 'Inception (2010)';

  it.each([
    ['poster.jpg'],
    ['folder.jpg'],
    [`${basename}-poster.jpg`],
    ['cover.jpg'],
  ])('finds poster candidate %s', async (name) => {
    const dir = path.join(root, 'movie');
    await mkdir(dir, { recursive: true });
    const art = await touch(path.join(dir, name));
    expect(await findLocalArtwork(dir, 'poster', basename, [root])).toBe(art);
  });

  it.each([['fanart.jpg'], ['backdrop.jpg'], [`${basename}-fanart.jpg`]])(
    'finds backdrop candidate %s',
    async (name) => {
      const dir = path.join(root, 'movie');
      await mkdir(dir, { recursive: true });
      const art = await touch(path.join(dir, name));
      expect(await findLocalArtwork(dir, 'backdrop', basename, [root])).toBe(art);
    },
  );

  it('prefers poster.jpg over folder.jpg over cover.jpg', async () => {
    const dir = path.join(root, 'movie');
    await mkdir(dir, { recursive: true });
    await touch(path.join(dir, 'cover.jpg'));
    await touch(path.join(dir, 'folder.jpg'));
    const poster = await touch(path.join(dir, 'poster.jpg'));
    expect(await findLocalArtwork(dir, 'poster', basename, [root])).toBe(poster);
  });

  it('returns null when no artwork is present', async () => {
    const dir = path.join(root, 'movie');
    await mkdir(dir, { recursive: true });
    expect(await findLocalArtwork(dir, 'poster', basename, [root])).toBeNull();
  });

  it('never returns a decoy above the media root', async () => {
    // Media root is a subdirectory; a poster in its PARENT must be ignored.
    const mediaRoot = path.join(root, 'library');
    await mkdir(mediaRoot, { recursive: true });
    await touch(path.join(root, 'poster.jpg')); // decoy, above the root
    expect(await findLocalArtwork(root, 'poster', undefined, [mediaRoot])).toBeNull();
  });

  it('rejects a symlink whose target escapes the media root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'aura-escape-'));
    try {
      const target = path.join(outside, 'evil.jpg');
      await touch(target);
      const dir = path.join(root, 'movie');
      await mkdir(dir, { recursive: true });
      await symlink(target, path.join(dir, 'poster.jpg'));
      expect(await findLocalArtwork(dir, 'poster', undefined, [root])).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// readLocalMetadata + artwork-cache contract
// ---------------------------------------------------------------------------

describe('readLocalMetadata', () => {
  it('reads nfo + poster + backdrop for a movie', async () => {
    const dir = path.join(root, 'Inception (2010)');
    await mkdir(dir, { recursive: true });
    const video = path.join(dir, 'Inception (2010).mkv');
    await touch(video);
    await touch(path.join(dir, 'Inception (2010).nfo'), MOVIE_NFO);
    const poster = await touch(path.join(dir, 'poster.jpg'));
    const fanart = await touch(path.join(dir, 'fanart.jpg'));

    const local = await readLocalMetadata({ videoPath: video, itemType: 'movie', mediaRoots: [root] });
    expect(local.nfo?.title).toBe('Inception');
    expect(local.posterPath).toBe(poster);
    expect(local.backdropPath).toBe(fanart);
  });

  it('reads tvshow.nfo + artwork for a show folder', async () => {
    const dir = path.join(root, 'Cowboy Bebop');
    await mkdir(dir, { recursive: true });
    await touch(path.join(dir, 'tvshow.nfo'), '<tvshow><title>Cowboy Bebop</title></tvshow>');
    const poster = await touch(path.join(dir, 'poster.jpg'));

    const local = await readLocalMetadata({ showDir: dir, itemType: 'show', mediaRoots: [root] });
    expect(local.nfo?.title).toBe('Cowboy Bebop');
    expect(local.posterPath).toBe(poster);
  });

  it('returns { nfo: null } and no artwork when nothing is present', async () => {
    const dir = path.join(root, 'movie');
    await mkdir(dir, { recursive: true });
    const video = path.join(dir, 'movie.mkv');
    await touch(video);
    const local = await readLocalMetadata({ videoPath: video, itemType: 'movie', mediaRoots: [root] });
    expect(local).toEqual({ nfo: null, posterPath: undefined, backdropPath: undefined });
  });
});

describe('artwork-cache contract', () => {
  it('resolves a discovered local poster (bare absolute path) into a cached image', async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), 'aura-cache-'));
    try {
      const dir = path.join(root, 'movie');
      await mkdir(dir, { recursive: true });
      const poster = path.join(dir, 'poster.jpg');
      await sharp({
        create: { width: 12, height: 18, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .jpeg()
        .toFile(poster);

      const found = await findLocalArtwork(dir, 'poster', undefined, [root]);
      expect(found).toBe(poster);

      const resolved = await resolveArtwork(found as string, 'w200', {
        configDir,
        mediaRoots: [root],
      });
      expect(resolved.contentType).toBe('image/webp');
      expect(resolved.filePath).toContain(configDir);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
