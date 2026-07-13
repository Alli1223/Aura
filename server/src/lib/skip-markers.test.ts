import { describe, expect, it } from 'vitest';

import {
  classifyChapterTitle,
  deriveSkipMarkers,
  type SkipChapter,
  type SkipConfig,
} from './skip-markers.js';

// Unit tests for the pure intro/credits marker derivation. No DB or IO.

describe('classifyChapterTitle', () => {
  it('classifies intro-like titles as intro', () => {
    for (const title of ['Intro', 'Opening', 'OP', 'Recap', 'Previously on Zeta', '  intro ']) {
      expect(classifyChapterTitle(title)).toBe('intro');
    }
  });

  it('classifies credits-like titles as credits', () => {
    for (const title of ['Credits', 'Ending', 'ED', 'Outro', 'Preview', 'Next Episode']) {
      expect(classifyChapterTitle(title)).toBe('credits');
    }
  });

  it('ignores non-matching, blank and absent titles', () => {
    for (const title of ['Chapter 1', 'The Heist', 'Part 2', 'Wedding', '', '   ']) {
      expect(classifyChapterTitle(title)).toBeNull();
    }
    expect(classifyChapterTitle(null)).toBeNull();
  });

  it('does not treat a prefix-only word like "operation" as intro', () => {
    expect(classifyChapterTitle('Operation Overlord')).toBeNull();
  });
});

describe('deriveSkipMarkers — chapter based', () => {
  const chapters: SkipChapter[] = [
    { startMs: 0, endMs: 90_000, title: 'Opening' },
    { startMs: 90_000, endMs: 1_200_000, title: 'Episode' },
    { startMs: 1_200_000, endMs: 1_320_000, title: 'Ending' },
  ];

  it('maps matching chapter ranges to intro/credits markers and ignores the rest', () => {
    const markers = deriveSkipMarkers({ chapters, durationMs: 1_320_000, config: null });
    expect(markers).toEqual([
      { type: 'intro', startMs: 0, endMs: 90_000 },
      { type: 'credits', startMs: 1_200_000, endMs: 1_320_000 },
    ]);
  });

  it('returns no markers when no chapter matches and there is no config', () => {
    const plain: SkipChapter[] = [
      { startMs: 0, endMs: 60_000, title: 'Cold Open' },
      { startMs: 60_000, endMs: 120_000, title: 'Chapter 2' },
    ];
    expect(deriveSkipMarkers({ chapters: plain, durationMs: 120_000, config: null })).toEqual([]);
  });

  it('drops a zero-length matching chapter', () => {
    const zero: SkipChapter[] = [{ startMs: 5_000, endMs: 5_000, title: 'Intro' }];
    expect(deriveSkipMarkers({ chapters: zero, durationMs: 100_000, config: null })).toEqual([]);
  });
});

describe('deriveSkipMarkers — per-show offset synthesis (no chapters)', () => {
  const noChapters: SkipChapter[] = [];

  it('synthesises an intro [0, introEndMs] from config', () => {
    const config: SkipConfig = { introEndMs: 30_000, creditsStartMs: null, creditsFromEndMs: null };
    const markers = deriveSkipMarkers({ chapters: noChapters, durationMs: 600_000, config });
    expect(markers).toEqual([{ type: 'intro', startMs: 0, endMs: 30_000 }]);
  });

  it('synthesises a credits marker from an absolute creditsStartMs', () => {
    const config: SkipConfig = {
      introEndMs: null,
      creditsStartMs: 540_000,
      creditsFromEndMs: null,
    };
    const markers = deriveSkipMarkers({ chapters: noChapters, durationMs: 600_000, config });
    expect(markers).toEqual([{ type: 'credits', startMs: 540_000, endMs: 600_000 }]);
  });

  it('synthesises a credits marker from creditsFromEndMs (duration - N)', () => {
    const config: SkipConfig = {
      introEndMs: null,
      creditsStartMs: null,
      creditsFromEndMs: 60_000,
    };
    const markers = deriveSkipMarkers({ chapters: noChapters, durationMs: 600_000, config });
    expect(markers).toEqual([{ type: 'credits', startMs: 540_000, endMs: 600_000 }]);
  });

  it('synthesises both an intro and a credits marker together, sorted by start', () => {
    const config: SkipConfig = {
      introEndMs: 30_000,
      creditsStartMs: null,
      creditsFromEndMs: 60_000,
    };
    const markers = deriveSkipMarkers({ chapters: noChapters, durationMs: 600_000, config });
    expect(markers).toEqual([
      { type: 'intro', startMs: 0, endMs: 30_000 },
      { type: 'credits', startMs: 540_000, endMs: 600_000 },
    ]);
  });

  it('cannot synthesise credits without a known duration', () => {
    const config: SkipConfig = {
      introEndMs: 30_000,
      creditsStartMs: null,
      creditsFromEndMs: 60_000,
    };
    const markers = deriveSkipMarkers({ chapters: noChapters, durationMs: null, config });
    // Intro still synthesises (no duration needed); credits is dropped.
    expect(markers).toEqual([{ type: 'intro', startMs: 0, endMs: 30_000 }]);
  });

  it('clamps a credits start below zero up to zero', () => {
    const config: SkipConfig = {
      introEndMs: null,
      creditsStartMs: null,
      creditsFromEndMs: 900_000,
    };
    const markers = deriveSkipMarkers({ chapters: noChapters, durationMs: 600_000, config });
    expect(markers).toEqual([{ type: 'credits', startMs: 0, endMs: 600_000 }]);
  });
});

describe('deriveSkipMarkers — chapter/config precedence', () => {
  it('prefers a chapter marker over the config for the same side', () => {
    const chapters: SkipChapter[] = [{ startMs: 0, endMs: 90_000, title: 'Opening' }];
    const config: SkipConfig = { introEndMs: 30_000, creditsStartMs: null, creditsFromEndMs: null };
    const markers = deriveSkipMarkers({ chapters, durationMs: 600_000, config });
    // The chapter's [0, 90000] wins; the config's 30000 intro is not added.
    expect(markers).toEqual([{ type: 'intro', startMs: 0, endMs: 90_000 }]);
  });

  it('fills only the side the chapters miss', () => {
    // A chapter supplies the intro; config supplies the missing credits.
    const chapters: SkipChapter[] = [{ startMs: 0, endMs: 90_000, title: 'Intro' }];
    const config: SkipConfig = {
      introEndMs: 30_000,
      creditsStartMs: null,
      creditsFromEndMs: 60_000,
    };
    const markers = deriveSkipMarkers({ chapters, durationMs: 600_000, config });
    expect(markers).toEqual([
      { type: 'intro', startMs: 0, endMs: 90_000 },
      { type: 'credits', startMs: 540_000, endMs: 600_000 },
    ]);
  });
});
