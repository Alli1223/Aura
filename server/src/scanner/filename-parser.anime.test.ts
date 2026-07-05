import { describe, expect, it } from 'vitest';

import { parseEpisodePath } from './filename-parser.js';
import type { ParsedEpisode, ParsedUnknown } from './filename-parser.js';

const anime = { anime: true };

type AnimeCase = {
  path: string;
  expected: ParsedEpisode | ParsedUnknown;
};

describe('parseEpisodePath (anime)', () => {
  describe('absolute numbering with group tags', () => {
    const cases: AnimeCase[] = [
      {
        path: '[SubsPlease] Sousou no Frieren - 12 (1080p) [F02B9CE5].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Sousou no Frieren',
          episode: 12,
          absolute: true,
          releaseGroup: 'SubsPlease',
        },
      },
      {
        path: '[Erai-raws] Show - 05 [1080p][Multiple Subtitle].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          episode: 5,
          absolute: true,
          releaseGroup: 'Erai-raws',
        },
      },
      {
        path: '[Group] Show - 12 [1080p][HEVC].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          episode: 12,
          absolute: true,
          releaseGroup: 'Group',
        },
      },
      {
        // No group tag at all.
        path: 'Show - 03.mkv',
        expected: { type: 'episode', showTitle: 'Show', episode: 3, absolute: true },
      },
      {
        // Big absolute numbers (long-running shows).
        path: '[Group] One Piece - 1043 [720p].mkv',
        expected: {
          type: 'episode',
          showTitle: 'One Piece',
          episode: 1043,
          absolute: true,
          releaseGroup: 'Group',
        },
      },
      {
        // Numbers in the show title do not confuse the episode number.
        path: '[Group] Mob Psycho 100 - 07 [720p].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Mob Psycho 100',
          episode: 7,
          absolute: true,
          releaseGroup: 'Group',
        },
      },
      {
        path: '[Group] Show - 2nd Season - 05.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show - 2nd Season',
          episode: 5,
          absolute: true,
          releaseGroup: 'Group',
        },
      },
      {
        // Episode title after the number.
        path: '[Group] Show - 12 - Departure [1080p].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          episode: 12,
          absolute: true,
          releaseGroup: 'Group',
          episodeTitle: 'Departure',
        },
      },
      {
        // Year in parentheses is tolerated and captured.
        path: 'Show (2024) - 03.mkv',
        expected: { type: 'episode', showTitle: 'Show', episode: 3, absolute: true, year: 2024 },
      },
      {
        // Season folder supplies the season for absolute-numbered files.
        path: 'Show/Season 1/[Group] Show - 12.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 12,
          absolute: true,
          releaseGroup: 'Group',
        },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path, anime)).toEqual(expected);
    });
  });

  describe('versions and ranges', () => {
    const cases: AnimeCase[] = [
      {
        path: '[Group] Show - 12v2 [720p].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          episode: 12,
          absolute: true,
          version: 2,
          releaseGroup: 'Group',
        },
      },
      {
        path: '[Group] Show - 12 v2.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          episode: 12,
          absolute: true,
          version: 2,
          releaseGroup: 'Group',
        },
      },
      {
        path: '[Group] Show - 01-02.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          episode: 1,
          episodeEnd: 2,
          absolute: true,
          releaseGroup: 'Group',
        },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path, anime)).toEqual(expected);
    });
  });

  describe('half/recap episodes bail out as unknown', () => {
    const cases: AnimeCase[] = [
      {
        path: 'Show - 12.5.mkv',
        expected: { type: 'unknown', title: 'Show - 12.5' },
      },
      {
        path: '[Group] Show - 06.5 [1080p].mkv',
        expected: { type: 'unknown', title: 'Show - 06.5' },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path, anime)).toEqual(expected);
    });
  });

  describe('SxxEyy still parses normally inside anime libraries', () => {
    const cases: AnimeCase[] = [
      {
        path: '[Group] Show S01E02 [1080p].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 2,
          releaseGroup: 'Group',
        },
      },
      {
        path: '[Group] Show S01E01-E02 [1080p].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 1,
          episode: 1,
          episodeEnd: 2,
          releaseGroup: 'Group',
        },
      },
      {
        path: 'Show.S02E05.1080p.WEB-DL.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 2, episode: 5 },
      },
      {
        path: 'Show - 1x02.mkv',
        expected: { type: 'episode', showTitle: 'Show', season: 1, episode: 2 },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path, anime)).toEqual(expected);
    });
  });

  describe('OVA and special markers', () => {
    const cases: AnimeCase[] = [
      {
        path: '[Group] Show - OVA 2.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 0,
          episode: 2,
          releaseGroup: 'Group',
        },
      },
      {
        // Number before the marker.
        path: '[Group] Show - 05 [OVA].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 0,
          episode: 5,
          releaseGroup: 'Group',
        },
      },
      {
        path: '[Group] Show NCOP1 [1080p].mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 0,
          episode: 1,
          releaseGroup: 'Group',
        },
      },
      {
        path: '[Group] Show SP02.mkv',
        expected: {
          type: 'episode',
          showTitle: 'Show',
          season: 0,
          episode: 2,
          releaseGroup: 'Group',
        },
      },
      {
        // Marker without any number cannot be identified.
        path: '[Group] Show NCED.mkv',
        expected: { type: 'unknown', title: 'Show NCED' },
      },
      {
        path: 'Show - OVA.mkv',
        expected: { type: 'unknown', title: 'Show - OVA' },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseEpisodePath(path, anime)).toEqual(expected);
    });
  });

  describe('anime-only behaviour is opt-in', () => {
    it('absolute numbering is not applied without the anime flag', () => {
      expect(parseEpisodePath('[Group] Show - 12 [1080p].mkv')).toEqual({
        type: 'unknown',
        title: 'Show - 12',
      });
    });

    it('a dash-year is a year, not an absolute episode', () => {
      expect(parseEpisodePath('Show - 2010.mkv', anime)).toEqual({
        type: 'unknown',
        title: 'Show - 2010',
      });
    });
  });
});
