import { describe, expect, it } from 'vitest';

import { formatDuration } from './adminHelpers';

describe('formatDuration', () => {
  it('formats sub-second and second ranges', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(500)).toBe('500 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
  });

  it('carries rounded seconds up into the minute instead of rendering "60s"', () => {
    expect(formatDuration(119_600)).toBe('2m 0s');
    expect(formatDuration(90_000)).toBe('1m 30s');
  });
});
