import { describe, expect, it } from 'vitest';

import { locateThumbnail, trickplaySpriteUrl, type TrickplayManifest } from './trickplay';

// A hand-built multi-sheet manifest exercises row-wrap, sheet-spill and
// clamping deterministically. It mirrors the fixture the server's own
// locateThumbnail test uses, so both sides of the contract stay in lockstep.
const manifest: TrickplayManifest = {
  version: 1,
  mediaFileId: 'math',
  sourceSize: 1,
  sourceMtimeMs: 1,
  intervalSec: 10,
  thumbWidth: 320,
  thumbHeight: 180,
  columns: 10,
  rows: 10,
  tilesPerSheet: 100,
  thumbnailCount: 150,
  sheets: ['sprite-0.jpg', 'sprite-1.jpg'],
};

describe('locateThumbnail (manifest math)', () => {
  // time → expected { index, sheet, col, row } (x/y derived from thumb size).
  const cases: {
    name: string;
    timeSec: number;
    index: number;
    sheet: string;
    col: number;
    row: number;
  }[] = [
    {
      name: 'first tile, top-left of sheet 0',
      timeSec: 0,
      index: 0,
      sheet: 'sprite-0.jpg',
      col: 0,
      row: 0,
    },
    {
      name: 'sub-interval floors to the same tile',
      timeSec: 5,
      index: 0,
      sheet: 'sprite-0.jpg',
      col: 0,
      row: 0,
    },
    {
      name: 'one interval advances one column',
      timeSec: 10,
      index: 1,
      sheet: 'sprite-0.jpg',
      col: 1,
      row: 0,
    },
    {
      name: 'wraps to the next row within a sheet',
      timeSec: 120,
      index: 12,
      sheet: 'sprite-0.jpg',
      col: 2,
      row: 1,
    },
    {
      name: 'spills onto the next sheet past tilesPerSheet',
      timeSec: 1000,
      index: 100,
      sheet: 'sprite-1.jpg',
      col: 0,
      row: 0,
    },
    {
      name: 'last real tile on sheet 1',
      timeSec: 1490,
      index: 149,
      sheet: 'sprite-1.jpg',
      col: 9,
      row: 4,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(locateThumbnail(manifest, testCase.timeSec)).toEqual({
        index: testCase.index,
        sheet: testCase.sheet,
        x: testCase.col * manifest.thumbWidth,
        y: testCase.row * manifest.thumbHeight,
        width: manifest.thumbWidth,
        height: manifest.thumbHeight,
      });
    });
  }

  it('clamps a time past the end to the last thumbnail', () => {
    const tile = locateThumbnail(manifest, 999_999);
    expect(tile.index).toBe(149);
    expect(tile.sheet).toBe('sprite-1.jpg');
  });

  it('clamps a negative or non-finite time to the first thumbnail', () => {
    expect(locateThumbnail(manifest, -5).index).toBe(0);
    expect(locateThumbnail(manifest, Number.NaN).index).toBe(0);
    expect(locateThumbnail(manifest, Number.POSITIVE_INFINITY).index).toBe(0);
  });
});

describe('trickplaySpriteUrl', () => {
  it('builds the token-carrying sprite URL', () => {
    expect(trickplaySpriteUrl('file-1', 'sprite-0.jpg', 'stream-token')).toBe(
      '/api/stream/trickplay/file-1/sprite-0.jpg?token=stream-token',
    );
  });

  it('encodes the file id, sprite name and token', () => {
    expect(trickplaySpriteUrl('a/b', 'sprite 1', 't ok')).toBe(
      '/api/stream/trickplay/a%2Fb/sprite%201?token=t%20ok',
    );
  });
});
