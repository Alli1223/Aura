import { describe, expect, it } from 'vitest';

import {
  computeEtag,
  contentDispositionInline,
  contentTypeForPath,
  DEFAULT_CONTENT_TYPE,
  etagMatches,
  resolveRequestRange,
  type RangeResolution,
} from './direct-play.js';

describe('contentTypeForPath', () => {
  it.each([
    ['/media/movies/film.mkv', 'video/x-matroska'],
    ['/media/movies/film.mp4', 'video/mp4'],
    ['/media/movies/film.m4v', 'video/x-m4v'],
    ['/media/movies/film.webm', 'video/webm'],
    ['/media/movies/film.avi', 'video/x-msvideo'],
    ['/media/movies/film.mov', 'video/quicktime'],
    ['/media/recordings/show.ts', 'video/mp2t'],
    ['/media/recordings/show.m2ts', 'video/mp2t'],
    ['/media/movies/film.mpg', 'video/mpeg'],
    ['/media/movies/film.mpeg', 'video/mpeg'],
    ['/media/movies/film.wmv', 'video/x-ms-wmv'],
    ['/media/movies/film.flv', 'video/x-flv'],
    ['/media/movies/film.ogv', 'video/ogg'],
  ])('maps %s to %s', (filePath, expected) => {
    expect(contentTypeForPath(filePath)).toBe(expected);
  });

  it('is case-insensitive on the extension', () => {
    expect(contentTypeForPath('/media/movies/FILM.MKV')).toBe('video/x-matroska');
  });

  it('falls back to application/octet-stream for unknown or missing extensions', () => {
    expect(contentTypeForPath('/media/movies/film.xyz')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('/media/movies/noext')).toBe(DEFAULT_CONTENT_TYPE);
  });
});

describe('resolveRequestRange', () => {
  const SIZE = 1000;
  const full: RangeResolution = { kind: 'full' };

  it('returns full when there is no Range header', () => {
    expect(resolveRequestRange(undefined, SIZE)).toEqual(full);
  });

  it('resolves bounded ranges inclusively', () => {
    expect(resolveRequestRange('bytes=0-499', SIZE)).toEqual({ kind: 'range', start: 0, end: 499 });
    expect(resolveRequestRange('bytes=500-999', SIZE)).toEqual({
      kind: 'range',
      start: 500,
      end: 999,
    });
    expect(resolveRequestRange('bytes=42-42', SIZE)).toEqual({ kind: 'range', start: 42, end: 42 });
  });

  it('clamps an end past EOF to the final byte', () => {
    expect(resolveRequestRange('bytes=900-4000', SIZE)).toEqual({
      kind: 'range',
      start: 900,
      end: 999,
    });
  });

  it('resolves open-ended ranges to EOF', () => {
    expect(resolveRequestRange('bytes=250-', SIZE)).toEqual({ kind: 'range', start: 250, end: 999 });
    expect(resolveRequestRange('bytes=0-', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('resolves suffix ranges to the final N bytes', () => {
    expect(resolveRequestRange('bytes=-100', SIZE)).toEqual({ kind: 'range', start: 900, end: 999 });
  });

  it('serves the whole file for a suffix longer than the file', () => {
    expect(resolveRequestRange('bytes=-5000', SIZE)).toEqual({ kind: 'range', start: 0, end: 999 });
  });

  it('serves only the first range of a multi-range request', () => {
    expect(resolveRequestRange('bytes=0-99,200-299', SIZE)).toEqual({
      kind: 'range',
      start: 0,
      end: 99,
    });
    expect(resolveRequestRange('bytes= 100-199 , 300-399', SIZE)).toEqual({
      kind: 'range',
      start: 100,
      end: 199,
    });
    // Empty list elements before the first real spec are skipped.
    expect(resolveRequestRange('bytes=,50-59', SIZE)).toEqual({ kind: 'range', start: 50, end: 59 });
  });

  it('is unsatisfiable when the start is at or past EOF', () => {
    expect(resolveRequestRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRequestRange('bytes=1000-2000', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRequestRange('bytes=99999-', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('is unsatisfiable for a zero-length suffix', () => {
    expect(resolveRequestRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('is unsatisfiable for any range against an empty file', () => {
    expect(resolveRequestRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRequestRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it.each([
    'bytes=abc',
    'bytes=--5',
    'bytes=5--10',
    'bytes=-',
    'bytes=',
    'bytes=1.5-2',
    'items=0-5',
    'bytes 0-5',
    'bytes=500-100', // last-byte-pos before first-byte-pos invalidates the set
  ])('ignores the malformed header %j and serves the full file', (header) => {
    expect(resolveRequestRange(header, SIZE)).toEqual(full);
  });

  it('accepts the bytes unit case-insensitively', () => {
    expect(resolveRequestRange('BYTES=0-1', SIZE)).toEqual({ kind: 'range', start: 0, end: 1 });
  });
});

describe('computeEtag / etagMatches', () => {
  it('builds a weak etag from size and integer mtime', () => {
    expect(computeEtag(1024, 1699999999123.9)).toBe('W/"1024-1699999999123"');
  });

  it('matches its own etag and the strong form of the same tag', () => {
    const etag = computeEtag(10, 20);
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches('"10-20"', etag)).toBe(true);
  });

  it('matches within a comma-separated list and on *', () => {
    const etag = computeEtag(10, 20);
    expect(etagMatches(`"other", ${etag}, "another"`, etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
  });

  it('does not match different tags or an absent header', () => {
    const etag = computeEtag(10, 20);
    expect(etagMatches('W/"10-21"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches('', etag)).toBe(false);
  });
});

describe('contentDispositionInline', () => {
  it('quotes a plain ascii filename and mirrors it in filename*', () => {
    expect(contentDispositionInline('Movie (2024).mp4')).toBe(
      `inline; filename="Movie (2024).mp4"; filename*=UTF-8''Movie%20%282024%29.mp4`,
    );
  });

  it('sanitises quotes, backslashes and non-ascii out of the fallback', () => {
    const value = contentDispositionInline('Amélie "special"\\cut.mkv');
    expect(value.startsWith('inline; filename="Am_lie _special__cut.mkv"; ')).toBe(true);
    expect(value).toContain(`filename*=UTF-8''Am%C3%A9lie%20%22special%22%5Ccut.mkv`);
  });
});
