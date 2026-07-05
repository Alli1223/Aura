import { describe, expect, it } from 'vitest';

import { parseEpisodePath } from './filename-parser.js';
import type { ParsedEpisode, ParsedUnknown } from './filename-parser.js';

type EpisodeCase = {
  path: string;
  expected: ParsedEpisode | ParsedUnknown;
};

describe('parseEpisodePath (tv)', () => {
  describe('SxxEyy variants', () => {
    const cases: EpisodeCase[] = [
      {
        path: 'Show - S01E02 - Ep Title.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 2,
          episodeTitle: 'Ep Title',
        },
      },
      {
        path: 'Show.S01E02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2 },
      },
      {
        path: 'show.s1e2.mkv',
        expected: { type: 'episode', showTitle: 'show', season: 1, episode: 2 },
      },
      {
        path: 'Show.S01.E02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2 },
      },
      {
        path: 'SHOW.S01E02.MKV',
        expected: { type: 'episode', showTitle: 'SHOW', season: 1, episode: 2 },
      },
      {
        path: 'Show_S01E02_Title.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2, episodeTitle: 'Title' },
      },
      {
        path: 'the.office.us.s09e23.finale.720p.hdtv.x264-lol.mkv',
        expected: {
          type: 'episode',
          showTitle: 'the office us',
          season: 9,
          episode: 23,
          episodeTitle: 'finale',
          releaseGroup: 'lol',
        },
      },
      {
        path: 'Breaking.Bad.S05E14.Ozymandias.1080p.WEB-DL.DD5.1.H.264.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Breaking Bad',
          season: 5,
          episode: 14,
          episodeTitle: 'Ozymandias',
        },
      },
      {
        // Year in the filename belongs to the show.
        path: 'Show (2019) - S01E02 - Title.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 2,
          year: 2019,
          episodeTitle: 'Title',
        },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path)).toEqual(expected);
    });
  });

  describe('1x02 variants', () => {
    const cases: EpisodeCase[] = [
      {
        path: 'Show.1x02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2 },
      },
      {
        path: 'Show - 1x02 - Title.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2, episodeTitle: 'Title' },
      },
      {
        path: 'Show.12x03.720p.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 12, episode: 3 },
      },
      {
        // Video dimensions must not parse as season/episode.
        path: 'Show.S01E02.1920x1080.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2 },
      },
      {
        path: 'Some.Random.Video.1280x720.mkv',
        expected: { type: 'unknown', title: 'Some Random Video 1280x720' },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path)).toEqual(expected);
    });
  });

  describe('multi-episode files', () => {
    const cases: EpisodeCase[] = [
      {
        path: 'Show.S01E01E02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 1, episodeEnd: 2 },
      },
      {
        path: 'Show.S01E01-E02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 1, episodeEnd: 2 },
      },
      {
        path: 'Show.S01E01-02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 1, episodeEnd: 2 },
      },
      {
        path: 'Show.S01E01E02E03.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 1, episodeEnd: 3 },
      },
      {
        path: 'Show.1x01-1x02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 1, episodeEnd: 2 },
      },
      {
        path: 'Show.1x01-02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 1, episodeEnd: 2 },
      },
      {
        // An episode title starting with a number is not a range.
        path: 'Show - S01E05 - 42nd Street.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 5,
          episodeTitle: '42nd Street',
        },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path)).toEqual(expected);
    });
  });

  describe('folder context', () => {
    const cases: EpisodeCase[] = [
      {
        path: 'Show/Season 1/Show - S01E02 - Ep Title.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 2,
          episodeTitle: 'Ep Title',
        },
      },
      {
        // Show folder wins over the filename prefix.
        path: 'Real Show Name/Season 1/rsn.s01e02.mkv',
        expected: { type: 'episode', showTitle: 'Real Show Name', season: 1, episode: 2 },
      },
      {
        // Year on the show folder.
        path: 'Show (2019)/Season 1/Show - S01E02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2, year: 2019 },
      },
      {
        // Bare episode number inside a season folder.
        path: 'Show/Season 02/02 - Title.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 2, episode: 2, episodeTitle: 'Title' },
      },
      {
        path: 'Season 02/02 - Title.mkv',
        expected: { type: 'episode', season: 2, episode: 2, episodeTitle: 'Title' },
      },
      {
        path: 'Show/Season 02/E02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 2, episode: 2 },
      },
      {
        path: 'Show/S02/03.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 2, episode: 3 },
      },
      {
        // Explicit SxxEyy in the filename wins over the folder season.
        path: 'Show/Season 2/Show - S01E05.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 5 },
      },
      {
        // Bare number ranges inside a season folder.
        path: 'Show/Season 1/01-02 - Double.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 1,
          episodeEnd: 2,
          episodeTitle: 'Double',
        },
      },
      {
        // Windows separators.
        path: 'Show\\Season 1\\Show - S01E02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2 },
      },
      {
        // A bare numbered file without a season folder is not guessable.
        path: '02 - Title.mkv',
        expected: { type: 'unknown', title: '02 - Title' },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path)).toEqual(expected);
    });
  });

  describe('specials', () => {
    const cases: EpisodeCase[] = [
      {
        path: 'Show/Specials/Show - S00E03 - Making Of.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 0,
          episode: 3,
          episodeTitle: 'Making Of',
        },
      },
      {
        path: 'Show.S00E01.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 0, episode: 1 },
      },
      {
        path: 'Show/Season 0/01 - Pilot Special.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 0,
          episode: 1,
          episodeTitle: 'Pilot Special',
        },
      },
      {
        path: 'Show/Specials/03 - Christmas.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 0,
          episode: 3,
          episodeTitle: 'Christmas',
        },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path)).toEqual(expected);
    });
  });

  describe('worded episodes', () => {
    const cases: EpisodeCase[] = [
      {
        path: 'Show Season 1 Episode 2.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2 },
      },
      {
        path: 'Show.Ep.12.mkv',
        expected: { type: 'episode', showTitle: 'Show', episode: 12 },
      },
      {
        path: 'E05.mkv',
        expected: { type: 'episode', episode: 5 },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path)).toEqual(expected);
    });
  });

  it('scene tags after the marker never leak into the episode title', () => {
    expect(parseEpisodePath('Show.S02E08.Title.2160p.WEB-DL.DDP5.1.Atmos.HDR.HEVC-GRP.mkv')).toEqual(
      {
        type: 'episode',
        showTitle: 'Show',
        season: 2,
        episode: 8,
        episodeTitle: 'Title',
        releaseGroup: 'GRP',
      },
    );
  });

  it('plain movie-style names are unknown for episode parsing', () => {
    expect(parseEpisodePath('Inception (2010).mkv')).toEqual({
      type: 'unknown',
      title: 'Inception',
    });
  });
});
