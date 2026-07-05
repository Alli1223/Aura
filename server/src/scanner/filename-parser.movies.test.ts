import { describe, expect, it } from 'vitest';

import { parseMoviePath } from './filename-parser.js';
import type { ParsedMovie, ParsedUnknown } from './filename-parser.js';

type MovieCase = {
  path: string;
  expected: ParsedMovie | ParsedUnknown;
};

describe('parseMoviePath', () => {
  describe('plain names', () => {
    const cases: MovieCase[] = [
      {
        path: 'Inception (2010).mkv',
        expected: { type: 'movie', title: 'Inception', year: 2010 },
      },
      {
        path: 'Heat.mkv',
        expected: { type: 'movie', title: 'Heat' },
      },
      {
        path: 'Title - 2010.mp4',
        expected: { type: 'movie', title: 'Title', year: 2010 },
      },
      {
        path: 'The_Matrix_1999.mkv',
        expected: { type: 'movie', title: 'The Matrix', year: 1999 },
      },
      {
        path: 'Dr. Strange (2016).mkv',
        expected: { type: 'movie', title: 'Dr Strange', year: 2016 },
      },
      {
        path: '1917 (2019).mkv',
        expected: { type: 'movie', title: '1917', year: 2019 },
      },
      {
        path: '(500) Days of Summer (2009).mkv',
        expected: { type: 'movie', title: '(500) Days of Summer', year: 2009 },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseMoviePath(path)).toEqual(expected);
    });
  });

  describe('scene naming', () => {
    const cases: MovieCase[] = [
      {
        path: 'Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv',
        expected: { type: 'movie', title: 'Interstellar', year: 2014, releaseGroup: 'SPARKS' },
      },
      {
        path: 'inception.2010.1080P.bluray.X264-yify.mkv',
        expected: { type: 'movie', title: 'inception', year: 2010, releaseGroup: 'yify' },
      },
      {
        path: 'Avengers.Endgame.2019.2160p.UHD.BluRay.TrueHD.7.1.Atmos.x265-TERMiNAL.mkv',
        expected: { type: 'movie', title: 'Avengers Endgame', year: 2019, releaseGroup: 'TERMiNAL' },
      },
      {
        path: 'Movie.2010.Directors.Cut.1080p.mkv',
        expected: { type: 'movie', title: 'Movie', year: 2010 },
      },
      {
        path: 'Gladiator.2000.REMASTERED.1080p.BluRay.mkv',
        expected: { type: 'movie', title: 'Gladiator', year: 2000 },
      },
      {
        path: 'Movie.2015.PROPER.REPACK.720p.WEB-DL.AAC.5.1.mkv',
        expected: { type: 'movie', title: 'Movie', year: 2015 },
      },
      {
        path: 'Movie.2010.HDR.DV.10bit.EXTENDED.iNTERNAL.mkv',
        expected: { type: 'movie', title: 'Movie', year: 2010 },
      },
      {
        path: 'Movie.Title.2020.LIMITED.UNRATED.DTS.EAC3.AC3.FLAC.mkv',
        expected: { type: 'movie', title: 'Movie Title', year: 2020 },
      },
      {
        path: 'Some.Movie.2011.720p.HDTV.h.264.mkv',
        expected: { type: 'movie', title: 'Some Movie', year: 2011 },
      },
      {
        path: 'Pulp.Fiction.REMASTERED.mkv',
        expected: { type: 'movie', title: 'Pulp Fiction' },
      },
      {
        path: 'Movie [1080p] [WEBRip].mkv',
        expected: { type: 'movie', title: 'Movie' },
      },
      {
        path: 'Movie.Name.2160p.REMUX.HEVC.Atmos.mkv',
        expected: { type: 'movie', title: 'Movie Name' },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseMoviePath(path)).toEqual(expected);
    });
  });

  describe('folder context', () => {
    const cases: MovieCase[] = [
      {
        path: 'Inception (2010)/Inception.2010.1080p.BluRay.x264-GROUP.mkv',
        expected: { type: 'movie', title: 'Inception', year: 2010, releaseGroup: 'GROUP' },
      },
      {
        // Folder title/year win over whatever the file is called.
        path: 'Inception (2010)/random-dump_01.mkv',
        expected: { type: 'movie', title: 'Inception', year: 2010 },
      },
      {
        // Folder supplies the title, file supplies the year.
        path: 'Inception/Inception.2010.mkv',
        expected: { type: 'movie', title: 'Inception', year: 2010 },
      },
      {
        // Scene-named folder with a bare file inside.
        path: 'Inception.2010.1080p.BluRay.x264-GRP/inception.mkv',
        expected: { type: 'movie', title: 'Inception', year: 2010, releaseGroup: 'GRP' },
      },
      {
        // Only the immediate parent folder is considered.
        path: 'Collection/Iron Man (2008)/Iron.Man.2008.720p.mkv',
        expected: { type: 'movie', title: 'Iron Man', year: 2008 },
      },
      {
        // Windows separators are tolerated.
        path: 'Inception (2010)\\Inception.2010.mkv',
        expected: { type: 'movie', title: 'Inception', year: 2010 },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseMoviePath(path)).toEqual(expected);
    });
  });

  describe('years inside titles and edge years', () => {
    const cases: MovieCase[] = [
      {
        path: '2001 A Space Odyssey (1968).mkv',
        expected: { type: 'movie', title: '2001 A Space Odyssey', year: 1968 },
      },
      {
        path: '2001.A.Space.Odyssey.1968.720p.BluRay.mkv',
        expected: { type: 'movie', title: '2001 A Space Odyssey', year: 1968 },
      },
      {
        path: 'Blade.Runner.2049.2017.2160p.WEB-DL.x265-GRP.mkv',
        expected: { type: 'movie', title: 'Blade Runner 2049', year: 2017, releaseGroup: 'GRP' },
      },
      {
        path: 'Wonder.Woman.1984.2020.1080p.mkv',
        expected: { type: 'movie', title: 'Wonder Woman 1984', year: 2020 },
      },
      {
        // A lone year-like name is a title, not a year.
        path: '2012.mkv',
        expected: { type: 'movie', title: '2012' },
      },
      {
        path: '2012.2009.1080p.mkv',
        expected: { type: 'movie', title: '2012', year: 2009 },
      },
      {
        // Years outside 1900-2099 are not years.
        path: 'Movie.1899.mkv',
        expected: { type: 'movie', title: 'Movie 1899' },
      },
      {
        path: 'Movie.1900.mkv',
        expected: { type: 'movie', title: 'Movie', year: 1900 },
      },
      {
        path: 'Movie.2099.mkv',
        expected: { type: 'movie', title: 'Movie', year: 2099 },
      },
      {
        path: 'Movie (2100).mkv',
        expected: { type: 'movie', title: 'Movie (2100)' },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseMoviePath(path)).toEqual(expected);
    });
  });

  describe('resolution and part-number traps', () => {
    const cases: MovieCase[] = [
      {
        // 1080/2160 are resolutions, never years.
        path: 'Timeline.1080p.x264.mkv',
        expected: { type: 'movie', title: 'Timeline' },
      },
      {
        path: 'Movie.2160p.HDR10.mkv',
        expected: { type: 'movie', title: 'Movie' },
      },
      {
        path: 'Movie.2014.2160p.mkv',
        expected: { type: 'movie', title: 'Movie', year: 2014 },
      },
      {
        // "Part 2" numbers stay in the title.
        path: 'Back.to.the.Future.Part.2.mkv',
        expected: { type: 'movie', title: 'Back to the Future Part 2' },
      },
      {
        path: 'Movie.Part.2.2010.mkv',
        expected: { type: 'movie', title: 'Movie Part 2', year: 2010 },
      },
      {
        path: 'The.Godfather.Part.II.1974.mkv',
        expected: { type: 'movie', title: 'The Godfather Part II', year: 1974 },
      },
    ];
    it.each(cases)('$path', ({ path, expected }) => {
      expect(parseMoviePath(path)).toEqual(expected);
    });
  });

  describe('release groups', () => {
    it('does not treat a hyphenated title as a release group', () => {
      expect(parseMoviePath('Spider-Man.mkv')).toEqual({ type: 'movie', title: 'Spider-Man' });
    });

    it('captures the group only when scene markers are present', () => {
      expect(parseMoviePath('Movie.Title-GROUP.mkv')).toEqual({
        type: 'movie',
        title: 'Movie Title-GROUP',
      });
      expect(parseMoviePath('Movie.2012.720p-GROUP.mkv')).toEqual({
        type: 'movie',
        title: 'Movie',
        year: 2012,
        releaseGroup: 'GROUP',
      });
    });

    it('never captures a trailing year as the group', () => {
      expect(parseMoviePath('Movie.2010.720p-1999.mkv')).toEqual({
        type: 'movie',
        title: 'Movie',
        year: 2010,
      });
    });
  });

  it('no year anywhere still yields a movie', () => {
    expect(parseMoviePath('Some Movie.mkv')).toEqual({ type: 'movie', title: 'Some Movie' });
  });
});
