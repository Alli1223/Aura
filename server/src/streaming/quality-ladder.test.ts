import { describe, expect, it } from 'vitest';

import {
  clampQuality,
  DEFAULT_MAX_QUALITY,
  DEFAULT_QUALITY,
  effectiveMaxQuality,
  HLS_QUALITY_NAMES,
  HIGHEST_QUALITY,
  isHlsQualityName,
  LOWEST_QUALITY,
  QUALITIES,
  QUALITY_LADDER,
  QUALITY_NAMES,
  qualitiesUpTo,
  qualityByName,
  qualityNameSchema,
} from './quality-ladder.js';

// Pure unit tests for the quality ladder — the single source of truth consumed
// by the HLS session manager and the playback decision engine.

describe('ladder shape & ordering', () => {
  it('is descending (highest first) and matches QUALITY_NAMES', () => {
    expect(QUALITY_NAMES).toEqual(['1080p', '720p', '480p', '360p']);
    expect(HLS_QUALITY_NAMES).toEqual([...QUALITY_NAMES]);
    expect(QUALITY_LADDER.map((rung) => rung.name)).toEqual([...QUALITY_NAMES]);
    // Strictly descending width caps.
    const widths = QUALITY_LADDER.map((rung) => rung.maxWidth);
    expect(widths).toEqual([1920, 1280, 854, 640]);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeLessThan(widths[i - 1]!);
    }
    expect(HIGHEST_QUALITY).toBe('1080p');
    expect(LOWEST_QUALITY).toBe('360p');
    expect(DEFAULT_QUALITY).toBe('720p');
    expect(DEFAULT_MAX_QUALITY).toBe('1080p');
  });

  it('adds a 360p rung (640w, 800k video, 96k audio)', () => {
    const rung = qualityByName('360p');
    expect(rung).toMatchObject({
      name: '360p',
      maxWidth: 640,
      videoBitrate: '800k',
      audioBitrate: '96k',
    });
  });

  it('derives the QUALITIES record from the ladder without divergence', () => {
    for (const rung of QUALITY_LADDER) {
      const { name, ...quality } = rung;
      expect(QUALITIES[name]).toEqual(quality);
    }
  });
});

describe('isHlsQualityName / qualityByName', () => {
  it('narrows only known names', () => {
    expect(isHlsQualityName('360p')).toBe(true);
    expect(isHlsQualityName('1080p')).toBe(true);
    expect(isHlsQualityName('4k')).toBe(false);
    expect(isHlsQualityName('constructor')).toBe(false);
    expect(isHlsQualityName('')).toBe(false);
  });

  it('returns undefined for an unknown rung name', () => {
    expect(qualityByName('4k')).toBeUndefined();
    expect(qualityByName('720p')?.name).toBe('720p');
  });
});

describe('qualityNameSchema', () => {
  it('accepts every ladder name and rejects anything else', () => {
    for (const name of QUALITY_NAMES) expect(qualityNameSchema.parse(name)).toBe(name);
    expect(qualityNameSchema.safeParse('4k').success).toBe(false);
    expect(qualityNameSchema.safeParse('').success).toBe(false);
    expect(qualityNameSchema.safeParse(1080).success).toBe(false);
  });
});

describe('qualitiesUpTo', () => {
  it('returns the cap rung and everything below it, highest first', () => {
    expect(qualitiesUpTo('1080p').map((r) => r.name)).toEqual(['1080p', '720p', '480p', '360p']);
    expect(qualitiesUpTo('480p').map((r) => r.name)).toEqual(['480p', '360p']);
    expect(qualitiesUpTo('360p').map((r) => r.name)).toEqual(['360p']);
  });
});

describe('clampQuality', () => {
  it('lowers a request above the cap to the cap', () => {
    expect(clampQuality('1080p', '480p')).toBe('480p');
    expect(clampQuality('720p', '360p')).toBe('360p');
  });

  it('leaves a request at or below the cap unchanged', () => {
    expect(clampQuality('480p', '1080p')).toBe('480p');
    expect(clampQuality('360p', '720p')).toBe('360p');
    expect(clampQuality('720p', '720p')).toBe('720p');
  });

  it('falls back to the cap for an unknown requested quality', () => {
    expect(clampQuality('4k', '720p')).toBe('720p');
    expect(clampQuality('', '480p')).toBe('480p');
  });
});

describe('effectiveMaxQuality', () => {
  it('uses the server cap when the user has no personal cap', () => {
    expect(effectiveMaxQuality(null, '1080p')).toBe('1080p');
    expect(effectiveMaxQuality(undefined, '720p')).toBe('720p');
  });

  it('uses the lower of user and server caps (min by ladder order)', () => {
    expect(effectiveMaxQuality('480p', '1080p')).toBe('480p'); // user lower
    expect(effectiveMaxQuality('720p', '720p')).toBe('720p'); // equal
  });

  it('clamps a user cap above the server cap down to the server cap', () => {
    expect(effectiveMaxQuality('1080p', '720p')).toBe('720p');
    expect(effectiveMaxQuality('720p', '480p')).toBe('480p');
  });

  it('ignores an unknown user cap and falls back to the server cap', () => {
    expect(effectiveMaxQuality('4k', '720p')).toBe('720p');
  });
});
