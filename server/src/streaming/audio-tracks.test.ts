import { describe, expect, it } from 'vitest';

import {
  channelLayoutLabel,
  listAudioTracks,
  resolveAudioTrackIndex,
  type AudioStreamRow,
} from './audio-tracks.js';

// Pure unit tests for the audio-track listing/labelling helpers — no DB, no
// ffmpeg. These are the bulk of coverage for the audio-tracks feature and stay
// fast and deterministic.

/** A persisted audio MediaStream row, with sensible defaults. */
function row(overrides: Partial<AudioStreamRow> = {}): AudioStreamRow {
  return {
    streamIndex: overrides.streamIndex ?? 0,
    codec: overrides.codec ?? 'aac',
    language: overrides.language ?? null,
    title: overrides.title ?? null,
    channels: overrides.channels ?? 2,
    default: overrides.default ?? false,
  };
}

describe('channelLayoutLabel', () => {
  it('maps common channel counts to friendly layouts', () => {
    expect(channelLayoutLabel(1)).toBe('Mono');
    expect(channelLayoutLabel(2)).toBe('Stereo');
    expect(channelLayoutLabel(6)).toBe('5.1');
    expect(channelLayoutLabel(7)).toBe('6.1');
    expect(channelLayoutLabel(8)).toBe('7.1');
  });

  it('falls back to "<n>ch" for unusual counts and undefined for none', () => {
    expect(channelLayoutLabel(3)).toBe('3ch');
    expect(channelLayoutLabel(4)).toBe('4ch');
    expect(channelLayoutLabel(0)).toBeUndefined();
    expect(channelLayoutLabel(null)).toBeUndefined();
    expect(channelLayoutLabel(undefined)).toBeUndefined();
  });
});

describe('listAudioTracks', () => {
  it('assigns audio-relative indices in container (streamIndex) order', () => {
    // Deliberately out of order and non-contiguous container indices (video is
    // 0, audio streams are 1 and 3): the audio-relative index must be 0, 1.
    const tracks = listAudioTracks([
      row({ streamIndex: 3, language: 'jpn' }),
      row({ streamIndex: 1, language: 'eng' }),
    ]);
    expect(tracks.map((t) => t.index)).toEqual([0, 1]);
    expect(tracks.map((t) => t.language)).toEqual(['eng', 'jpn']);
  });

  it('builds a "language layout (CODEC)" label, e.g. English 5.1 (AC3)', () => {
    const [track] = listAudioTracks([
      row({ streamIndex: 1, language: 'eng', channels: 6, codec: 'ac3' }),
    ]);
    expect(track?.label).toBe('English 5.1 (AC3)');
    expect(track?.channelLayout).toBe('5.1');
    expect(track?.channels).toBe(6);
    expect(track?.codec).toBe('ac3');
  });

  it('labels a stereo aac Japanese track as "Japanese Stereo (AAC)"', () => {
    const [track] = listAudioTracks([
      row({ streamIndex: 1, language: 'jpn', channels: 2, codec: 'aac' }),
    ]);
    expect(track?.label).toBe('Japanese Stereo (AAC)');
  });

  it('falls back to the title, then "Audio N", when no language is known', () => {
    const withTitle = listAudioTracks([
      row({ streamIndex: 1, language: null, title: 'Commentary', channels: 2, codec: 'aac' }),
    ]);
    expect(withTitle[0]?.label).toBe('Commentary Stereo (AAC)');

    const bare = listAudioTracks([
      { streamIndex: 1, language: null, title: null, channels: null, codec: null, default: false },
    ]);
    // No language, title, layout or codec: just the positional fallback.
    expect(bare[0]?.label).toBe('Audio 1');
    expect(bare[0]?.channelLayout).toBeUndefined();
    expect(bare[0]?.codec).toBeUndefined();
  });

  it('preserves the default disposition per track', () => {
    const tracks = listAudioTracks([
      row({ streamIndex: 1, language: 'eng', default: true }),
      row({ streamIndex: 2, language: 'jpn', default: false }),
    ]);
    expect(tracks.map((t) => t.default)).toEqual([true, false]);
  });

  it('normalises an undetermined/blank language to undefined', () => {
    const tracks = listAudioTracks([
      row({ streamIndex: 1, language: 'und' }),
      row({ streamIndex: 2, language: '' }),
    ]);
    expect(tracks.map((t) => t.language)).toEqual([undefined, undefined]);
  });

  it('returns an empty list for a file with no audio streams', () => {
    expect(listAudioTracks([])).toEqual([]);
  });
});

describe('resolveAudioTrackIndex', () => {
  const tracks = listAudioTracks([
    row({ streamIndex: 1, language: 'eng', default: false }),
    row({ streamIndex: 2, language: 'jpn', default: true }),
    row({ streamIndex: 3, language: 'fra', default: false }),
  ]);

  it('honours an in-range requested index', () => {
    expect(resolveAudioTrackIndex(tracks, 0)).toBe(0);
    expect(resolveAudioTrackIndex(tracks, 2)).toBe(2);
  });

  it('falls back to the default track when the request is out of range', () => {
    // jpn (index 1) is flagged default.
    expect(resolveAudioTrackIndex(tracks, 99)).toBe(1);
  });

  it('falls back to the default track when omitted', () => {
    expect(resolveAudioTrackIndex(tracks, undefined)).toBe(1);
  });

  it('falls back to the first track when none is flagged default', () => {
    const noDefault = listAudioTracks([
      row({ streamIndex: 1, language: 'eng' }),
      row({ streamIndex: 2, language: 'jpn' }),
    ]);
    expect(resolveAudioTrackIndex(noDefault, undefined)).toBe(0);
    expect(resolveAudioTrackIndex(noDefault, 5)).toBe(0);
  });

  it('returns 0 for a file with no audio tracks', () => {
    expect(resolveAudioTrackIndex([], undefined)).toBe(0);
    expect(resolveAudioTrackIndex([], 3)).toBe(0);
  });
});
