import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildHlsFfmpegArgs,
  clampStartOffset,
  escapeSubtitlesFilterPath,
  HLS_PLAYLIST_NAME,
  HLS_QUALITY_NAMES,
  HlsInputError,
  HlsSessionManager,
  HlsStartError,
  isHlsQualityName,
  QUALITIES,
  TooManySessionsError,
  type BurnSubtitle,
  type HlsSessionManagerOptions,
} from './hls-session.js';

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

// ---------------------------------------------------------------------------
// Pure arg-builder tests — NO ffmpeg spawned. These are the bulk of coverage
// and stay fast and deterministic.
// ---------------------------------------------------------------------------

describe('buildHlsFfmpegArgs', () => {
  const base = {
    inputPath: '/media/movies/film.mkv',
    outputDir: '/config/transcodes/sess-1',
  };

  /** Returns the value immediately following the first occurrence of `flag`. */
  function valueAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  }

  it('positions the input path immediately after -i and only there', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    const iIndex = args.indexOf('-i');
    expect(iIndex).toBeGreaterThanOrEqual(0);
    expect(args[iIndex + 1]).toBe('/media/movies/film.mkv');
    // The path appears exactly once (not smuggled into another arg).
    expect(args.filter((a) => a === base.inputPath)).toHaveLength(1);
  });

  it('is a flat array of separate string arguments (never one shell string)', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['1080p'] });
    expect(Array.isArray(args)).toBe(true);
    for (const arg of args) expect(typeof arg).toBe('string');
    // No single element bundles the whole command with spaces + a binary name.
    expect(args.some((a) => a.includes('ffmpeg '))).toBe(false);
  });

  it('contains no shell command-injection metacharacters in any argument', () => {
    // The filtergraph legitimately uses ( ) , : ' and the keyframe expr uses *
    // — none of which can chain or execute commands. What must NEVER appear are
    // the shell control operators, which spawn-with-arg-array also renders inert
    // but which we still assert are absent as defence in depth.
    const injection = /[;&|`$<>\n\r]/;
    for (const name of HLS_QUALITY_NAMES) {
      const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES[name] });
      for (const arg of args) {
        expect(injection.test(arg), `arg ${JSON.stringify(arg)}`).toBe(false);
      }
    }
  });

  it.each(HLS_QUALITY_NAMES)('maps %s to its scale cap and bitrate arguments', (name) => {
    const quality = QUALITIES[name];
    const args = buildHlsFfmpegArgs({ ...base, quality });

    // Never upscale: the scale filter caps width at min(iw, maxWidth) and lets
    // height follow (-2 = even, aspect-preserving).
    expect(valueAfter(args, '-vf')).toBe(`scale='min(iw,${quality.maxWidth})':-2`);
    expect(valueAfter(args, '-b:v')).toBe(quality.videoBitrate);
    expect(valueAfter(args, '-maxrate')).toBe(quality.maxrate);
    expect(valueAfter(args, '-bufsize')).toBe(quality.bufsize);
    expect(valueAfter(args, '-b:a')).toBe(quality.audioBitrate);
  });

  it('encodes video with software libx264 (veryfast) and stereo aac audio', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    expect(valueAfter(args, '-c:v')).toBe('libx264');
    expect(valueAfter(args, '-preset')).toBe('veryfast');
    expect(valueAfter(args, '-c:a')).toBe('aac');
    expect(valueAfter(args, '-ac')).toBe('2');
  });

  it('maps the first video, the selected audio (optional), and drops subtitles', () => {
    const def = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['480p'] });
    expect(def).toContain('-sn');
    // -map appears for video and audio.
    const maps = def.reduce<string[]>((acc, arg, i) => {
      if (arg === '-map') acc.push(def[i + 1] as string);
      return acc;
    }, []);
    expect(maps).toEqual(['0:v:0', '0:a:0?']);

    const withAudio = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['480p'],
      audioStreamIndex: 2,
    });
    const audioMap = withAudio[withAudio.lastIndexOf('-map') + 1];
    expect(audioMap).toBe('0:a:2?');
  });

  /** The audio-relative index mapped by `-map 0:a:<n>?` (the last -map value). */
  function audioMapOf(args: string[]): string | undefined {
    return args[args.lastIndexOf('-map') + 1];
  }

  it('maps the selected audio-relative index (0:a:1)', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['480p'], audioStreamIndex: 1 });
    expect(audioMapOf(args)).toBe('0:a:1?');
  });

  it('falls back to the first audio track for an omitted/invalid index', () => {
    expect(audioMapOf(buildHlsFfmpegArgs({ ...base, quality: QUALITIES['480p'] }))).toBe('0:a:0?');
    for (const bad of [-1, 1.5, Number.NaN]) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['480p'],
        audioStreamIndex: bad,
      });
      expect(audioMapOf(args), String(bad)).toBe('0:a:0?');
    }
  });

  it('downmixes to stereo (-ac 2) by default and when downmixStereo is true', () => {
    expect(valueAfter(buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] }), '-ac')).toBe(
      '2',
    );
    // Even a surround source is forced to stereo when the client is stereo-only.
    const forced = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      downmixStereo: true,
      sourceChannels: 6,
    });
    expect(valueAfter(forced, '-ac')).toBe('2');
  });

  it('preserves a surround source channel count when downmix is opted out', () => {
    const surround = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      downmixStereo: false,
      sourceChannels: 6,
    });
    expect(valueAfter(surround, '-ac')).toBe('6');
  });

  it('caps preserved surround channels at MAX_TRANSCODE_AUDIO_CHANNELS (6)', () => {
    const eight = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      downmixStereo: false,
      sourceChannels: 8,
    });
    expect(valueAfter(eight, '-ac')).toBe('6');
  });

  it('keeps the stereo baseline when opting out but the source is not surround', () => {
    for (const channels of [undefined, 1, 2]) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['720p'],
        downmixStereo: false,
        sourceChannels: channels,
      });
      expect(valueAfter(args, '-ac'), String(channels)).toBe('2');
    }
  });

  it('never injects shell metacharacters via audio selection or downmix', () => {
    const injection = /[;&|`$<>\n\r]/;
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['1080p'],
      audioStreamIndex: 3,
      downmixStereo: false,
      sourceChannels: 6,
    });
    for (const arg of args) expect(injection.test(arg), JSON.stringify(arg)).toBe(false);
  });

  it('emits an EVENT HLS playlist with independent, appendable mpegts segments', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    expect(valueAfter(args, '-f')).toBe('hls');
    expect(valueAfter(args, '-hls_time')).toBe('4');
    expect(valueAfter(args, '-hls_playlist_type')).toBe('event');
    expect(valueAfter(args, '-hls_flags')).toBe('independent_segments+append_list');
    expect(valueAfter(args, '-hls_segment_type')).toBe('mpegts');
    // Segment pattern and playlist both live under the session dir; the
    // playlist path is the final positional argument.
    expect(valueAfter(args, '-hls_segment_filename')).toBe(
      path.join(base.outputDir, 'segment%05d.ts'),
    );
    expect(args[args.length - 1]).toBe(path.join(base.outputDir, HLS_PLAYLIST_NAME));
  });

  it('accepts a hardware encoder override without touching the rest of the pipeline', () => {
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      videoEncoder: 'h264_vaapi',
    });
    expect(valueAfter(args, '-c:v')).toBe('h264_vaapi');
  });

  it('never produces an upscaling filter: min(iw,...) caps at the source width', () => {
    for (const name of HLS_QUALITY_NAMES) {
      const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES[name] });
      const vf = args[args.indexOf('-vf') + 1] as string;
      expect(vf.startsWith("scale='min(iw,")).toBe(true);
    }
  });

  // -- transcode-seek: -ss placement & formatting -------------------------

  it('places -ss with the offset immediately BEFORE -i when startOffsetSec > 0', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 12 });
    const ssIndex = args.indexOf('-ss');
    const iIndex = args.indexOf('-i');
    expect(ssIndex).toBeGreaterThanOrEqual(0);
    // -ss is a fast INPUT seek: it must sit directly before -i (input option).
    expect(args[ssIndex + 1]).toBe('12');
    expect(ssIndex).toBeLessThan(iIndex);
    expect(iIndex - ssIndex).toBe(2); // -ss <val> -i
    // The input path still follows -i untouched.
    expect(args[iIndex + 1]).toBe(base.inputPath);
  });

  it('formats a fractional offset as trimmed fixed-point (no scientific notation)', () => {
    expect(
      valueAfter(
        buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 5.5 }),
        '-ss',
      ),
    ).toBe('5.5');
    // Whole numbers stay integer-formatted; sub-ms precision is trimmed.
    expect(
      valueAfter(
        buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 90 }),
        '-ss',
      ),
    ).toBe('90');
    expect(
      valueAfter(
        buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], startOffsetSec: 1.2345 }),
        '-ss',
      ),
    ).toBe('1.234');
  });

  it('omits -ss entirely for offset 0, undefined, negative, or non-finite', () => {
    for (const offset of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['720p'],
        startOffsetSec: offset,
      });
      expect(args.includes('-ss'), String(offset)).toBe(false);
      // -i is still the very first input option after the global flags.
      expect(args[args.indexOf('-i') + 1]).toBe(base.inputPath);
    }
  });

  it('never injects shell metacharacters via the seek offset', () => {
    const injection = /[;&|`$<>\n\r]/;
    for (const offset of [7, 5.5, 123.456, 3600]) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['1080p'],
        startOffsetSec: offset,
      });
      for (const arg of args) expect(injection.test(arg), JSON.stringify(arg)).toBe(false);
    }
  });

  // -- subtitle burn-in: -filter_complex composition ----------------------

  /** The `-filter_complex` value, or undefined when the builder emitted `-vf`. */
  function filterComplexOf(args: string[]): string | undefined {
    return valueAfter(args, '-filter_complex');
  }

  it('burns an IMAGE sub by overlaying its stream then scaling the composite', () => {
    const burn: BurnSubtitle = { type: 'overlay', subtitleIndex: 2 };
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], burnSubtitle: burn });

    // The graph overlays the decoded subtitle stream [0:s:2] onto the video and
    // THEN downscales the composited frame — one chain, ending in the mapped [v].
    expect(filterComplexOf(args)).toBe(`[0:v:0][0:s:2]overlay,scale='min(iw,1280)':-2[v]`);
    // -vf is gone (its scale moved inside the filter_complex); [v] is mapped as
    // the video output; -sn is dropped (no subtitle stream is output-mapped).
    expect(args).not.toContain('-vf');
    expect(args).not.toContain('-sn');
    const maps = args.reduce<string[]>((acc, a, i) => {
      if (a === '-map') acc.push(args[i + 1] as string);
      return acc;
    }, []);
    expect(maps).toEqual(['[v]', '0:a:0?']);
  });

  it('composes overlay + scale for every quality width cap', () => {
    for (const name of HLS_QUALITY_NAMES) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES[name],
        burnSubtitle: { type: 'overlay', subtitleIndex: 0 },
      });
      expect(filterComplexOf(args)).toBe(
        `[0:v:0][0:s:0]overlay,scale='min(iw,${QUALITIES[name].maxWidth})':-2[v]`,
      );
    }
  });

  it('burns an EMBEDDED TEXT sub via the subtitles filter reading the input (si=)', () => {
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['480p'],
      burnSubtitle: { type: 'embedded-text', subtitleIndex: 1 },
    });
    // The subtitles filter renders si=1 from the input file, then scale, then [v].
    expect(filterComplexOf(args)).toBe(
      `[0:v:0]subtitles=filename=${base.inputPath}:si=1,scale='min(iw,854)':-2[v]`,
    );
    expect(args).not.toContain('-vf');
  });

  it('burns an EXTERNAL TEXT sidecar via the subtitles filter reading its path', () => {
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      burnSubtitle: { type: 'external-text', filePath: '/media/movies/film.en.srt' },
    });
    // No si= for an external file (it holds a single subtitle track).
    expect(filterComplexOf(args)).toBe(
      `[0:v:0]subtitles=filename=/media/movies/film.en.srt,scale='min(iw,1280)':-2[v]`,
    );
  });

  it('falls back to subtitle index 0 for an invalid overlay index', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['720p'],
        burnSubtitle: { type: 'overlay', subtitleIndex: bad },
      });
      expect(filterComplexOf(args), String(bad)).toBe(
        `[0:v:0][0:s:0]overlay,scale='min(iw,1280)':-2[v]`,
      );
    }
  });

  it('keeps the audio selection intact alongside a burn-in', () => {
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      audioStreamIndex: 2,
      burnSubtitle: { type: 'overlay', subtitleIndex: 0 },
    });
    expect(args[args.lastIndexOf('-map') + 1]).toBe('0:a:2?');
  });

  it('leaves the non-burn args byte-for-byte unchanged (no -filter_complex)', () => {
    const withoutBurn = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    const explicitUndefined = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      burnSubtitle: undefined,
    });
    expect(explicitUndefined).toEqual(withoutBurn);
    expect(withoutBurn).not.toContain('-filter_complex');
    expect(withoutBurn).toContain('-vf');
    expect(withoutBurn).toContain('-sn');
  });

  it('never injects shell metacharacters via a burn-in filtergraph', () => {
    const injection = /[;&|`$<>\n\r]/;
    const burns: BurnSubtitle[] = [
      { type: 'overlay', subtitleIndex: 3 },
      { type: 'embedded-text', subtitleIndex: 0 },
      { type: 'external-text', filePath: '/media/tv/Show S01E01.en.srt' },
    ];
    for (const burn of burns) {
      const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['1080p'], burnSubtitle: burn });
      for (const arg of args) expect(injection.test(arg), JSON.stringify(arg)).toBe(false);
    }
  });

  // -- hardware acceleration: encoder + hwaccel flags + scale chain --------

  it('hwAccel none (explicit) is byte-for-byte the default software pipeline', () => {
    const implicit = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'] });
    const explicit = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], hwAccel: 'none' });
    // REGRESSION-CRITICAL: enabling the feature must not change software output.
    expect(explicit).toEqual(implicit);
    expect(explicit).not.toContain('-hwaccel');
    expect(valueAfter(explicit, '-c:v')).toBe('libx264');
    expect(valueAfter(explicit, '-vf')).toBe(`scale='min(iw,1280)':-2`);
  });

  it('vaapi: h264_vaapi, device-bound hwaccel flags before -i, scale_vaapi', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], hwAccel: 'vaapi' });
    expect(valueAfter(args, '-c:v')).toBe('h264_vaapi');
    expect(valueAfter(args, '-hwaccel')).toBe('vaapi');
    expect(valueAfter(args, '-hwaccel_device')).toBe('/dev/dri/renderD128');
    expect(valueAfter(args, '-hwaccel_output_format')).toBe('vaapi');
    expect(valueAfter(args, '-vf')).toBe(`scale_vaapi=w='min(iw,1280)':h=-2`);
    // hwaccel is an INPUT option → must precede -i.
    expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'));
    // Pixel format follows the GPU surface: no software -pix_fmt / -preset.
    expect(args).not.toContain('-pix_fmt');
    expect(args).not.toContain('-preset');
    expect(valueAfter(args, '-profile:v')).toBe('high');
    // Audio + HLS muxing are unchanged from software.
    expect(valueAfter(args, '-c:a')).toBe('aac');
    expect(valueAfter(args, '-b:v')).toBe(QUALITIES['720p'].videoBitrate);
    expect(valueAfter(args, '-f')).toBe('hls');
  });

  it('nvenc: h264_nvenc via cuda, no device node, scale_cuda', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['1080p'], hwAccel: 'nvenc' });
    expect(valueAfter(args, '-c:v')).toBe('h264_nvenc');
    expect(valueAfter(args, '-hwaccel')).toBe('cuda');
    expect(valueAfter(args, '-hwaccel_output_format')).toBe('cuda');
    // CUDA selects its GPU by index — no DRM render node is passed.
    expect(args).not.toContain('-hwaccel_device');
    expect(valueAfter(args, '-vf')).toBe(`scale_cuda=w='min(iw,1920)':h=-2`);
    expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'));
  });

  it('qsv: h264_qsv, device-bound hwaccel flags, scale_qsv', () => {
    const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['480p'], hwAccel: 'qsv' });
    expect(valueAfter(args, '-c:v')).toBe('h264_qsv');
    expect(valueAfter(args, '-hwaccel')).toBe('qsv');
    expect(valueAfter(args, '-hwaccel_device')).toBe('/dev/dri/renderD128');
    expect(valueAfter(args, '-hwaccel_output_format')).toBe('qsv');
    expect(valueAfter(args, '-vf')).toBe(`scale_qsv=w='min(iw,854)':h=-2`);
  });

  it('auto resolves to the vaapi arg set', () => {
    const auto = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], hwAccel: 'auto' });
    const vaapi = buildHlsFfmpegArgs({ ...base, quality: QUALITIES['720p'], hwAccel: 'vaapi' });
    expect(auto).toEqual(vaapi);
  });

  it('threads a custom hwAccelDevice into the vaapi/qsv flags', () => {
    for (const mode of ['vaapi', 'qsv'] as const) {
      const args = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['720p'],
        hwAccel: mode,
        hwAccelDevice: '/dev/dri/renderD129',
      });
      expect(valueAfter(args, '-hwaccel_device')).toBe('/dev/dri/renderD129');
    }
  });

  it('caps width per quality on every hardware scaler (never upscales)', () => {
    const scaler: Record<'vaapi' | 'nvenc' | 'qsv', string> = {
      vaapi: 'scale_vaapi',
      nvenc: 'scale_cuda',
      qsv: 'scale_qsv',
    };
    for (const [mode, filter] of Object.entries(scaler) as [keyof typeof scaler, string][]) {
      for (const name of HLS_QUALITY_NAMES) {
        const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES[name], hwAccel: mode });
        expect(valueAfter(args, '-vf')).toBe(
          `${filter}=w='min(iw,${QUALITIES[name].maxWidth})':h=-2`,
        );
      }
    }
  });

  it('places hwaccel flags before BOTH -ss and -i when seeking', () => {
    const args = buildHlsFfmpegArgs({
      ...base,
      quality: QUALITIES['720p'],
      hwAccel: 'vaapi',
      startOffsetSec: 30,
    });
    const hw = args.indexOf('-hwaccel');
    const ss = args.indexOf('-ss');
    const i = args.indexOf('-i');
    expect(hw).toBeGreaterThanOrEqual(0);
    expect(hw).toBeLessThan(ss);
    expect(ss).toBeLessThan(i);
    expect(args[i + 1]).toBe(base.inputPath);
  });

  it.each(['vaapi', 'nvenc', 'qsv'] as const)(
    'a burn-in forces %s back to software (byte-identical to a software burn)',
    (mode) => {
      const hw = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['720p'],
        hwAccel: mode,
        burnSubtitle: { type: 'overlay', subtitleIndex: 0 },
      });
      // No hardware pipeline: software encoder, filtergraph and pixel format.
      expect(hw).not.toContain('-hwaccel');
      expect(valueAfter(hw, '-c:v')).toBe('libx264');
      expect(valueAfter(hw, '-filter_complex')).toBe(
        `[0:v:0][0:s:0]overlay,scale='min(iw,1280)':-2[v]`,
      );
      expect(hw).toContain('-pix_fmt');
      // Identical to requesting the same burn-in with software encoding.
      const software = buildHlsFfmpegArgs({
        ...base,
        quality: QUALITIES['720p'],
        hwAccel: 'none',
        burnSubtitle: { type: 'overlay', subtitleIndex: 0 },
      });
      expect(hw).toEqual(software);
    },
  );

  it('produces no shell metacharacters in any hardware arg set', () => {
    const injection = /[;&|`$<>\n\r]/;
    for (const mode of ['vaapi', 'nvenc', 'qsv', 'auto'] as const) {
      for (const name of HLS_QUALITY_NAMES) {
        const args = buildHlsFfmpegArgs({ ...base, quality: QUALITIES[name], hwAccel: mode });
        for (const arg of args) {
          expect(injection.test(arg), `${mode}/${name}: ${JSON.stringify(arg)}`).toBe(false);
        }
      }
    }
  });
});

describe('escapeSubtitlesFilterPath', () => {
  it('passes an ordinary path through unchanged', () => {
    expect(escapeSubtitlesFilterPath('/media/movies/film.en.srt')).toBe(
      '/media/movies/film.en.srt',
    );
    expect(escapeSubtitlesFilterPath('/media/tv/Show S01E01.srt')).toBe(
      '/media/tv/Show S01E01.srt',
    );
  });

  it('escapes filtergraph-special characters so a filename cannot inject syntax', () => {
    // Graph separators are neutralised (single backslash before each).
    expect(escapeSubtitlesFilterPath('/m/a,b.srt')).toBe('/m/a\\,b.srt');
    expect(escapeSubtitlesFilterPath('/m/a;b.srt')).toBe('/m/a\\;b.srt');
    expect(escapeSubtitlesFilterPath('/m/a[b].srt')).toBe('/m/a\\[b\\].srt');
  });

  it('double-escapes the option separator and quote (two-level filtergraph rule)', () => {
    // `:` and `'` are special at BOTH the arg and graph level, so they end up
    // with two backslashes / a backslash-escaped quote respectively.
    expect(escapeSubtitlesFilterPath('/m/a:b.srt')).toBe('/m/a\\\\:b.srt');
    expect(escapeSubtitlesFilterPath("/m/a'b.srt")).toBe("/m/a\\\\\\'b.srt");
  });
});

describe('clampStartOffset', () => {
  it('returns 0 for an omitted, non-positive, or non-finite request', () => {
    for (const req of [undefined, 0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampStartOffset(req, 100), String(req)).toBe(0);
    }
  });

  it('passes a positive offset through when the duration is unknown', () => {
    expect(clampStartOffset(42, undefined)).toBe(42);
    expect(clampStartOffset(42, 0)).toBe(42);
    expect(clampStartOffset(42.5, Number.NaN)).toBe(42.5);
  });

  it('keeps an offset that falls within the known duration', () => {
    expect(clampStartOffset(30, 100)).toBe(30);
    expect(clampStartOffset(99.9, 100)).toBe(99.9);
  });

  it('caps an offset at or beyond the end to the duration', () => {
    expect(clampStartOffset(150, 100)).toBe(100);
    expect(clampStartOffset(100, 100)).toBe(100);
  });
});

describe('quality ladder', () => {
  it('exposes 1080p / 720p / 480p / 360p with descending width caps', () => {
    expect(HLS_QUALITY_NAMES).toEqual(['1080p', '720p', '480p', '360p']);
    expect(QUALITIES['1080p'].maxWidth).toBe(1920);
    expect(QUALITIES['720p'].maxWidth).toBe(1280);
    expect(QUALITIES['480p'].maxWidth).toBe(854);
    expect(QUALITIES['360p'].maxWidth).toBe(640);
  });

  it('narrows only known quality names', () => {
    expect(isHlsQualityName('720p')).toBe(true);
    expect(isHlsQualityName('4k')).toBe(false);
    expect(isHlsQualityName('constructor')).toBe(false);
    expect(isHlsQualityName('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spawn-based tests — REAL ffmpeg. Kept few and pointed at tiny clips so the
// suite stays fast. ffmpeg is a hard project dependency (Docker image + CI).
// ---------------------------------------------------------------------------

async function assertFfmpeg(): Promise<void> {
  try {
    await execFileAsync(FFMPEG, ['-version']);
  } catch (cause) {
    throw new Error(
      `"${FFMPEG}" is not runnable. ffmpeg is required for the HLS test suite — ` +
        'install ffmpeg or set FFMPEG_PATH.',
      { cause },
    );
  }
}

/** Reads a media playlist and returns the .ts segment names it lists. */
function segmentsInPlaylist(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts'));
}

describe('HlsSessionManager (real ffmpeg)', () => {
  let root: string;
  let mediaRoot: string;
  let transcodeDir: string;
  let outsideDir: string;
  let clipPath: string;
  let srtPath: string;
  const managers: HlsSessionManager[] = [];

  function makeManager(overrides: Partial<HlsSessionManagerOptions> = {}): HlsSessionManager {
    const manager = new HlsSessionManager({
      mediaRoots: [mediaRoot],
      getTranscodeDir: () => transcodeDir,
      ffmpegPath: FFMPEG,
      idleMs: 60_000,
      maxSessions: 3,
      readinessTimeoutMs: 30_000,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  }

  beforeAll(async () => {
    await assertFfmpeg();
    root = await mkdtemp(path.join(tmpdir(), 'aura-hls-mgr-'));
    mediaRoot = path.join(root, 'media');
    transcodeDir = path.join(root, 'transcodes');
    outsideDir = path.join(root, 'outside');
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(transcodeDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    clipPath = path.join(mediaRoot, 'clip.mp4');
    // 5s 640x480 h264 + stereo aac — small but long enough to yield >1 segment.
    // prettier-ignore
    await execFileAsync(FFMPEG, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x480:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ac', '2', '-shortest',
      clipPath,
    ]);

    // An external subtitle sidecar inside the media root — burned via the real
    // libass `subtitles` filter (an embedded image sub is hard to synthesize;
    // the route suite exercises the embedded-text path end-to-end).
    srtPath = path.join(mediaRoot, 'clip.en.srt');
    await writeFile(srtPath, '1\n00:00:00,000 --> 00:00:04,000\nBurned in caption\n', 'utf8');
  }, 120_000);

  afterEach(async () => {
    await Promise.all(managers.map((m) => m.shutdown()));
    managers.length = 0;
    // No scratch dirs may survive a manager shutdown.
    const remaining = existsSync(transcodeDir) ? await readdir(transcodeDir) : [];
    expect(remaining).toEqual([]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const startClip = (
    manager: HlsSessionManager,
    over: Partial<{
      userId: string;
      quality: '1080p' | '720p' | '480p';
      id: string;
      startOffsetSec: number;
    }> = {},
  ) =>
    manager.startSession({
      mediaFile: { id: over.id ?? 'file-1', path: clipPath },
      quality: over.quality ?? '480p',
      userId: over.userId ?? 'user-1',
      startOffsetSec: over.startOffsetSec,
    });

  it('starts a session that resolves once a playlist and >=1 segment exist', async () => {
    const manager = makeManager();
    const session = await startClip(manager);

    expect(session.state).toBe('ready');
    expect(existsSync(session.outputDir)).toBe(true);
    const playlist = await readFile(path.join(session.outputDir, HLS_PLAYLIST_NAME), 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(segmentsInPlaylist(playlist).length).toBeGreaterThanOrEqual(1);
    expect(manager.getSession(session.id)).toBeDefined();
    expect(manager.activeCount).toBe(1);
  }, 60_000);

  it('listSessions returns live sessions with the display fields and no process handles', async () => {
    const manager = makeManager();
    const session = await startClip(manager, { id: 'file-list', userId: 'user-list' });

    const list = manager.listSessions();
    expect(list).toHaveLength(1);
    const [snapshot] = list;

    // Exactly the documented display/identity fields — no more, no less.
    expect(Object.keys(snapshot!).sort()).toEqual(
      [
        'audioTrackIndex',
        'burnSubtitleTrackId',
        'createdAt',
        'downmixStereo',
        'id',
        'lastAccess',
        'mediaFileId',
        'quality',
        'startOffsetSec',
        'state',
        'userId',
      ].sort(),
    );
    expect(snapshot).toMatchObject({
      id: session.id,
      mediaFileId: 'file-list',
      userId: 'user-list',
      quality: '480p',
      audioTrackIndex: 0,
      downmixStereo: true,
      startOffsetSec: 0,
      burnSubtitleTrackId: undefined,
      state: 'ready',
    });
    expect(typeof snapshot!.createdAt).toBe('number');
    expect(typeof snapshot!.lastAccess).toBe('number');

    // Never leak the ffmpeg child, its stderr, the input path or the scratch dir.
    const leaked = snapshot as unknown as Record<string, unknown>;
    expect(leaked.process).toBeUndefined();
    expect(leaked.inputPath).toBeUndefined();
    expect(leaked.outputDir).toBeUndefined();
    expect(leaked.stderrTail).toBeUndefined();
    expect(leaked.ready).toBeUndefined();

    await manager.stopSession(session.id);
    // A stopped session drops out of the snapshot.
    expect(manager.listSessions()).toEqual([]);
  }, 60_000);

  it('transcodes the whole clip to completion (ENDLIST + every segment on disk)', async () => {
    const manager = makeManager();
    const session = await startClip(manager);

    const playlistPath = path.join(session.outputDir, HLS_PLAYLIST_NAME);
    const deadline = Date.now() + 45_000;
    let text = '';
    do {
      text = await readFile(playlistPath, 'utf8');
      if (text.includes('#EXT-X-ENDLIST')) break;
      await new Promise((r) => setTimeout(r, 150));
    } while (Date.now() < deadline);

    expect(text).toContain('#EXT-X-ENDLIST');
    const segments = segmentsInPlaylist(text);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    for (const segment of segments) {
      expect(existsSync(path.join(session.outputDir, segment)), segment).toBe(true);
    }
  }, 60_000);

  it('reuses the live session for an identical (user,file,quality) request', async () => {
    const manager = makeManager();
    const first = await startClip(manager);
    const second = await startClip(manager);

    expect(second.id).toBe(first.id);
    expect(second.outputDir).toBe(first.outputDir);
    expect(manager.activeCount).toBe(1);
  }, 60_000);

  it('rejects the session beyond the concurrency cap with TooManySessionsError', async () => {
    const manager = makeManager({ maxSessions: 3 });
    await startClip(manager, { userId: 'u1' });
    await startClip(manager, { userId: 'u2' });
    await startClip(manager, { userId: 'u3' });
    expect(manager.activeCount).toBe(3);

    await expect(startClip(manager, { userId: 'u4' })).rejects.toBeInstanceOf(TooManySessionsError);
  }, 90_000);

  it('reaps an idle session: kills ffmpeg and removes the scratch dir', async () => {
    let clock = Date.now();
    const manager = makeManager({ idleMs: 50_000, now: () => clock });
    const session = await startClip(manager);
    const dir = session.outputDir;
    expect(existsSync(dir)).toBe(true);

    clock += 60_000; // advance the injected clock past the idle window
    await manager.reapIdleSessions();

    expect(manager.getSession(session.id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(manager.activeCount).toBe(0);
  }, 60_000);

  it('does not reap a session that was touched within the idle window', async () => {
    let clock = Date.now();
    const manager = makeManager({ idleMs: 50_000, now: () => clock });
    const session = await startClip(manager);

    clock += 40_000;
    manager.touch(session.id); // resets lastAccess to the current clock
    clock += 40_000; // 40s since the touch < 50s idle
    await manager.reapIdleSessions();

    expect(manager.getSession(session.id)).toBeDefined();
    expect(existsSync(session.outputDir)).toBe(true);
  }, 60_000);

  it('stops a session, killing ffmpeg and removing its dir (idempotent)', async () => {
    const manager = makeManager();
    const session = await startClip(manager);
    const dir = session.outputDir;

    await manager.stopSession(session.id);
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false);

    // Idempotent: stopping again (and an unknown id) is a no-op.
    await expect(manager.stopSession(session.id)).resolves.toBeUndefined();
    await expect(manager.stopSession('nope')).resolves.toBeUndefined();
  }, 60_000);

  it('starts a seeked session (-ss) that yields a serviceable playlist + segment', async () => {
    const manager = makeManager();
    const session = await startClip(manager, { startOffsetSec: 2 });

    expect(session.state).toBe('ready');
    expect(session.startOffsetSec).toBe(2);
    const playlist = await readFile(path.join(session.outputDir, HLS_PLAYLIST_NAME), 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(segmentsInPlaylist(playlist).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('reuses one session for the same offset and starts a DISTINCT one per offset', async () => {
    const manager = makeManager();
    const first = await startClip(manager, { startOffsetSec: 1 });
    const same = await startClip(manager, { startOffsetSec: 1 });
    const other = await startClip(manager, { startOffsetSec: 3 });

    // Same offset => reuse (same id, same dir); different offset => distinct.
    expect(same.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    // The zero-offset (default) start is distinct from any seeked one, too.
    const zero = await startClip(manager, {});
    expect(zero.id).not.toBe(first.id);
    expect(zero.id).not.toBe(other.id);
  }, 90_000);

  it('buckets sub-second offsets to whole seconds for dedup', async () => {
    const manager = makeManager();
    const a = await startClip(manager, { startOffsetSec: 2.2 });
    const b = await startClip(manager, { startOffsetSec: 2.8 });
    const c = await startClip(manager, { startOffsetSec: 3.0 });

    // 2.2 and 2.8 both bucket to whole-second 2 => reuse; 3.0 is a new bucket.
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  }, 90_000);

  it("supersedes a user's prior different-offset session, leaving another user untouched", async () => {
    const manager = makeManager();
    // Two users watching the SAME file at offset 0.
    const a0 = await startClip(manager, { userId: 'alice', id: 'file-shared', startOffsetSec: 0 });
    const b0 = await startClip(manager, { userId: 'bob', id: 'file-shared', startOffsetSec: 0 });
    expect(manager.activeCount).toBe(2);

    // Alice seeks: her offset-0 session is retired (freeing the slot); Bob's is not.
    const a5 = await startClip(manager, { userId: 'alice', id: 'file-shared', startOffsetSec: 5 });

    expect(manager.getSession(a0.id)).toBeUndefined();
    expect(existsSync(a0.outputDir)).toBe(false); // scratch dir cleaned
    expect(manager.getSession(b0.id)).toBeDefined(); // other user untouched
    expect(existsSync(b0.outputDir)).toBe(true);
    expect(manager.getSession(a5.id)).toBeDefined();
    // Alice still holds exactly one slot; total active is Bob + Alice's new one.
    expect(manager.activeCount).toBe(2);
  }, 90_000);

  it('supersede frees a slot so a seek does not trip the concurrency cap', async () => {
    const manager = makeManager({ maxSessions: 2 });
    // Fill the cap: one for Bob, one for Alice (both at offset 0).
    await startClip(manager, { userId: 'bob', id: 'file-b', startOffsetSec: 0 });
    const aliceStart = await startClip(manager, {
      userId: 'alice',
      id: 'file-a',
      startOffsetSec: 0,
    });
    expect(manager.activeCount).toBe(2);

    // Alice seeks her file: her old session is superseded first, so this fits
    // under the cap instead of throwing TooManySessionsError.
    const aliceSeek = await startClip(manager, {
      userId: 'alice',
      id: 'file-a',
      startOffsetSec: 4,
    });
    expect(aliceSeek.id).not.toBe(aliceStart.id);
    expect(manager.getSession(aliceStart.id)).toBeUndefined();
    expect(manager.activeCount).toBe(2);
  }, 90_000);

  it('rejects an input path outside the media roots with HlsInputError', async () => {
    const manager = makeManager();
    const outside = path.join(outsideDir, 'secret.mp4');
    await execFileAsync(FFMPEG, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=320x240:rate=10',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      outside,
    ]);

    const err = await manager
      .startSession({ mediaFile: { id: 'x', path: outside }, quality: '480p', userId: 'u' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlsInputError);
    expect((err as HlsInputError).reason).toBe('outside_roots');
    expect(existsSync(transcodeDir) ? await readdir(transcodeDir) : []).toEqual([]);
  }, 60_000);

  it('rejects a missing input path with a missing HlsInputError', async () => {
    const manager = makeManager();
    const err = await manager
      .startSession({
        mediaFile: { id: 'x', path: path.join(mediaRoot, 'gone.mp4') },
        quality: '480p',
        userId: 'u',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlsInputError);
    expect((err as HlsInputError).reason).toBe('missing');
  }, 60_000);

  it('shutdown stops every session and leaves no scratch dirs behind', async () => {
    const manager = makeManager();
    const a = await startClip(manager, { userId: 'a' });
    const b = await startClip(manager, { userId: 'b' });
    expect(existsSync(a.outputDir) && existsSync(b.outputDir)).toBe(true);

    await manager.shutdown();

    expect(manager.getSession(a.id)).toBeUndefined();
    expect(manager.getSession(b.id)).toBeUndefined();
    expect(existsSync(a.outputDir)).toBe(false);
    expect(existsSync(b.outputDir)).toBe(false);
  }, 60_000);

  // -- subtitle burn-in (real ffmpeg) -------------------------------------

  /** Starts a session burning the external `clip.en.srt` sidecar into the video. */
  const startBurn = (
    manager: HlsSessionManager,
    over: { trackId?: string; userId?: string } = {},
  ) =>
    manager.startSession({
      mediaFile: { id: 'file-1', path: clipPath },
      quality: '480p',
      userId: over.userId ?? 'user-1',
      burnSubtitle: {
        trackId: over.trackId ?? 'external-0123456789abcdef',
        spec: { type: 'external-text', filePath: srtPath },
      },
    });

  it('burns a subtitle into a session that yields a serviceable playlist + segment', async () => {
    const manager = makeManager();
    const session = await startBurn(manager);

    expect(session.state).toBe('ready');
    expect(session.burnSubtitleTrackId).toBe('external-0123456789abcdef');
    const playlist = await readFile(path.join(session.outputDir, HLS_PLAYLIST_NAME), 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(segmentsInPlaylist(playlist).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('makes a burn-in session distinct from a no-subs session and per burned track', async () => {
    const manager = makeManager();
    const plain = await startClip(manager); // no burn
    const burnA = await startBurn(manager, { trackId: 'external-aaaaaaaaaaaaaaaa' });
    const burnAAgain = await startBurn(manager, { trackId: 'external-aaaaaaaaaaaaaaaa' });
    const burnB = await startBurn(manager, { trackId: 'embedded-3' });

    // No-burn vs burn => distinct; same track => reuse; different track => distinct.
    expect(burnA.id).not.toBe(plain.id);
    expect(burnAAgain.id).toBe(burnA.id);
    expect(burnB.id).not.toBe(burnA.id);
    expect(burnB.id).not.toBe(plain.id);
  }, 90_000);

  it('rejects a burn-in subtitle path outside the media roots with HlsInputError', async () => {
    const manager = makeManager();
    const outsideSrt = path.join(outsideDir, 'evil.srt');
    await writeFile(outsideSrt, '1\n00:00:00,000 --> 00:00:01,000\nx\n', 'utf8');

    const err = await manager
      .startSession({
        mediaFile: { id: 'file-1', path: clipPath },
        quality: '480p',
        userId: 'u',
        burnSubtitle: {
          trackId: 'external-ffffffffffffffff',
          spec: { type: 'external-text', filePath: outsideSrt },
        },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HlsInputError);
    expect((err as HlsInputError).reason).toBe('outside_roots');
    // No scratch dir was left behind by the rejected start.
    expect(existsSync(transcodeDir) ? await readdir(transcodeDir) : []).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Automatic software fallback (hw-accel). No GPU and no real ffmpeg: the
// process spawner is faked so a HARDWARE attempt can deterministically fail
// (with a chosen stderr) and a SOFTWARE attempt succeed. This proves the retry
// wiring — hardware error => one software retry; non-hardware error => none.
// The hardware ARG SHAPES are covered by the pure buildHlsFfmpegArgs tests
// above; only the fallback control flow is exercised here.
// ---------------------------------------------------------------------------

/** Minimal stderr stub: an emitter with a no-op setEncoding. */
class FakeStderr extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

/** Minimal ChildProcess stand-in whose kill() resolves as an exit. */
class FakeChild extends EventEmitter {
  readonly stderr = new FakeStderr();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal?: NodeJS.Signals): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  }
}

describe('HlsSessionManager hardware fallback (fake spawn)', () => {
  let root: string;
  let mediaRoot: string;
  let transcodeDir: string;
  let inputPath: string;
  const managers: HlsSessionManager[] = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aura-hls-hw-'));
    mediaRoot = path.join(root, 'media');
    transcodeDir = path.join(root, 'transcodes');
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(transcodeDir, { recursive: true });
    // A real regular file inside the media root (containment-checked before any
    // spawn). Its contents are irrelevant — ffmpeg is faked.
    inputPath = path.join(mediaRoot, 'input.mp4');
    await writeFile(inputPath, 'not-real-media', 'utf8');
  });

  afterEach(async () => {
    await Promise.all(managers.map((m) => m.shutdown()));
    managers.length = 0;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Fake spawner: a HARDWARE attempt (args include `-hwaccel`) fails with the
   * given stderr; a SOFTWARE attempt writes a serviceable playlist so readiness
   * resolves. Records the args of every spawn so the test can assert which
   * pipeline ran.
   */
  function makeSpawn(hwStderr: string): { fn: typeof spawn; calls: string[][] } {
    const calls: string[][] = [];
    const fn = ((_command: string, args: readonly string[]): ChildProcess => {
      calls.push([...args]);
      const child = new FakeChild();
      const playlistPath = args[args.length - 1] as string;
      if (args.includes('-hwaccel')) {
        // Emit after listeners attach (next tick), stderr before exit.
        setImmediate(() => {
          child.stderr.emit('data', hwStderr);
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      } else {
        writeFileSync(
          playlistPath,
          '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment00000.ts\n',
        );
        // Leave the child "running"; the readiness poller sees the playlist.
      }
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    return { fn, calls };
  }

  function makeManager(overrides: Partial<HlsSessionManagerOptions>): HlsSessionManager {
    const manager = new HlsSessionManager({
      mediaRoots: [mediaRoot],
      getTranscodeDir: () => transcodeDir,
      ffmpegPath: 'ffmpeg-not-used',
      idleMs: 60_000,
      maxSessions: 3,
      readinessTimeoutMs: 5_000,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  }

  function fakeLogger(warn: ReturnType<typeof vi.fn>): FastifyBaseLogger {
    const logger = {
      warn,
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: () => logger,
    };
    return logger as unknown as FastifyBaseLogger;
  }

  it('falls back to software when a hardware start fails with a hardware error', async () => {
    const { fn, calls } = makeSpawn(
      '[h264_vaapi @ 0x1] Failed to open the drm device /dev/dri/renderD128',
    );
    const warn = vi.fn();
    const manager = makeManager({
      getHwAccel: () => 'vaapi',
      spawnFn: fn,
      logger: fakeLogger(warn),
    });

    const session = await manager.startSession({
      mediaFile: { id: 'f1', path: inputPath },
      quality: '720p',
      userId: 'u1',
    });

    expect(session.state).toBe('ready');
    // Two spawns: hardware first, then the software retry.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('-hwaccel');
    expect(calls[0]).toContain('h264_vaapi');
    expect(calls[1]).not.toContain('-hwaccel');
    expect(calls[1]).toContain('libx264');
    // The fallback was logged as a warning.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('resolves auto to a hardware attempt then falls back to software', async () => {
    const { fn, calls } = makeSpawn('No VA display found for device /dev/dri/renderD128');
    const manager = makeManager({ getHwAccel: () => 'auto', spawnFn: fn });

    const session = await manager.startSession({
      mediaFile: { id: 'f-auto', path: inputPath },
      quality: '480p',
      userId: 'u-auto',
    });

    expect(session.state).toBe('ready');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('h264_vaapi'); // auto -> vaapi
    expect(calls[1]).toContain('libx264');
  });

  it('does NOT retry when a hardware start fails with a non-hardware error', async () => {
    const { fn, calls } = makeSpawn('Invalid data found when processing input');
    const manager = makeManager({ getHwAccel: () => 'vaapi', spawnFn: fn });

    const err = await manager
      .startSession({ mediaFile: { id: 'f2', path: inputPath }, quality: '720p', userId: 'u2' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HlsStartError);
    // Exactly one spawn — a non-hardware failure must not loop into a retry.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('-hwaccel');
    // The failed session was cleaned up (no leaked slot or scratch dir).
    expect(manager.activeCount).toBe(0);
    expect(existsSync(transcodeDir) ? await readdir(transcodeDir) : []).toEqual([]);
  });

  it('never attempts hardware when the mode is none (single software spawn)', async () => {
    const { fn, calls } = makeSpawn('unused');
    const manager = makeManager({ getHwAccel: () => 'none', spawnFn: fn });

    const session = await manager.startSession({
      mediaFile: { id: 'f3', path: inputPath },
      quality: '720p',
      userId: 'u3',
    });

    expect(session.state).toBe('ready');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('-hwaccel');
    expect(calls[0]).toContain('libx264');
  });

  it('a burn-in with a hardware mode transcodes in software with no hardware attempt', async () => {
    const { fn, calls } = makeSpawn('unused');
    const manager = makeManager({ getHwAccel: () => 'vaapi', spawnFn: fn });

    const session = await manager.startSession({
      mediaFile: { id: 'f4', path: inputPath },
      quality: '720p',
      userId: 'u4',
      burnSubtitle: { trackId: 'embedded-1', spec: { type: 'embedded-text', subtitleIndex: 1 } },
    });

    expect(session.state).toBe('ready');
    expect(session.burnSubtitleTrackId).toBe('embedded-1');
    // One software spawn: the burn-in rule skipped hardware entirely.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('-hwaccel');
    expect(calls[0]).toContain('libx264');
    expect(calls[0]).toContain('-filter_complex');
  });
});
