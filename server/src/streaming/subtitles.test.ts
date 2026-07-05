import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { probeFile, type ProbeSubtitleStream } from '../media/ffprobe.js';
import {
  classifySubtitleKind,
  extractWebVtt,
  ffmpegWebVttConverter,
  hasWebVttHeader,
  ImageSubtitleError,
  isValidTrackId,
  languageLabel,
  listSubtitles,
  parseSidecarName,
  resolveBurnSubtitle,
  SubtitleConversionError,
  SubtitleNotFoundError,
  type EmbeddedSubtitleStream,
  type SubtitleMediaFile,
  type WebVttConverter,
} from './subtitles.js';

// These tests exercise the real ffmpeg/ffprobe binaries against tiny fixtures
// generated once in beforeAll, exactly like the ffprobe test suite. ffmpeg is a
// hard requirement of the project (Docker image + CI both ship it); a missing
// binary fails the suite loudly rather than skipping.

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

const VALID_VTT = 'WEBVTT\n\n00:00.000 --> 00:01.000\nExternal cue\n';

let tempDir: string;
let mediaRoot: string;
let outsideDir: string;
let transcodeDir: string;
let movieMkv: string;
let embeddedStreams: EmbeddedSubtitleStream[];

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, ['-y', '-v', 'error', ...args]);
}

function toEmbeddedStreams(streams: ProbeSubtitleStream[]): EmbeddedSubtitleStream[] {
  return streams.map((stream) => ({
    streamIndex: stream.index,
    codec: stream.codec,
    language: stream.language,
    title: stream.title,
    forced: stream.isForced,
    default: stream.isDefault,
  }));
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-subtitles-test-'));
  mediaRoot = path.join(tempDir, 'media');
  outsideDir = path.join(tempDir, 'outside');
  transcodeDir = path.join(tempDir, 'transcodes');
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await mkdir(transcodeDir, { recursive: true });

  // A forced eng srt subtitle to embed, mirroring the ffprobe fixture.
  const srtPath = path.join(tempDir, 'embed.srt');
  await writeFile(
    srtPath,
    '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n',
    'utf8',
  );

  // Movie.mkv: h264 video + aac audio + a forced eng srt subtitle track.
  movieMkv = path.join(mediaRoot, 'Movie.mkv');
  // prettier-ignore
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-i', srtPath,
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:s:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2',
    '-c:s', 'srt',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
    '-disposition:s:0', 'forced',
    movieMkv,
  ]);

  const probe = await probeFile(movieMkv);
  embeddedStreams = toEmbeddedStreams(
    probe.streams.filter((s): s is ProbeSubtitleStream => s.type === 'subtitle'),
  );
  expect(embeddedStreams).toHaveLength(1);

  // External sidecars next to Movie.mkv.
  await writeFile(
    path.join(mediaRoot, 'Movie.en.srt'),
    '1\n00:00:00,000 --> 00:00:02,000\nSidecar English\n',
    'utf8',
  );
  await writeFile(
    path.join(mediaRoot, 'Movie.fr.forced.srt'),
    '1\n00:00:00,000 --> 00:00:02,000\nSidecar forced French\n',
    'utf8',
  );
  await writeFile(path.join(mediaRoot, 'Movie.vtt'), VALID_VTT, 'utf8');
  // A non-subtitle sibling that must be ignored.
  await writeFile(path.join(mediaRoot, 'Movie.nfo'), '<nfo/>', 'utf8');
}, 120_000);

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function movieMediaFile(overrides: Partial<SubtitleMediaFile> = {}): SubtitleMediaFile {
  return {
    id: overrides.id ?? `file-${randomUUID().slice(0, 8)}`,
    path: overrides.path ?? movieMkv,
    subtitleStreams: overrides.subtitleStreams ?? embeddedStreams,
  };
}

describe('classifySubtitleKind', () => {
  it('classifies image codecs as image (need burn-in)', () => {
    for (const codec of [
      'pgs',
      'hdmv_pgs_subtitle',
      'dvd_subtitle',
      'dvdsub',
      'vobsub',
      'dvbsub',
      'dvb_subtitle',
      'HDMV_PGS_SUBTITLE',
    ]) {
      expect(classifySubtitleKind(codec), codec).toBe('image');
    }
  });

  it('classifies text codecs (and unknown/undefined) as text', () => {
    for (const codec of ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'weird', undefined]) {
      expect(classifySubtitleKind(codec), String(codec)).toBe('text');
    }
  });
});

describe('parseSidecarName', () => {
  it('parses language and forced flags from sidecar names', () => {
    expect(parseSidecarName('Movie.srt', 'Movie')).toMatchObject({
      format: 'srt',
      language: undefined,
      forced: false,
    });
    expect(parseSidecarName('Movie.en.srt', 'Movie')).toMatchObject({
      format: 'srt',
      language: 'en',
      forced: false,
    });
    expect(parseSidecarName('Movie.eng.forced.srt', 'Movie')).toMatchObject({
      format: 'srt',
      language: 'eng',
      forced: true,
    });
    expect(parseSidecarName('Movie.forced.srt', 'Movie')).toMatchObject({
      language: undefined,
      forced: true,
    });
    expect(parseSidecarName('Movie.vtt', 'Movie')).toMatchObject({ format: 'vtt' });
    expect(parseSidecarName('Movie.ass', 'Movie')).toMatchObject({ format: 'ass' });
  });

  it('rejects non-sidecar files and other videos', () => {
    expect(parseSidecarName('Movie.mkv', 'Movie')).toBeUndefined();
    expect(parseSidecarName('Movie.nfo', 'Movie')).toBeUndefined();
    expect(parseSidecarName('Other.en.srt', 'Movie')).toBeUndefined();
    expect(parseSidecarName('Movie.jpg', 'Movie')).toBeUndefined();
  });
});

describe('languageLabel', () => {
  it('maps known codes and falls back to the uppercased code', () => {
    expect(languageLabel('en')).toBe('English');
    expect(languageLabel('eng')).toBe('English');
    expect(languageLabel('jpn')).toBe('Japanese');
    expect(languageLabel('zz')).toBe('ZZ');
    expect(languageLabel(undefined)).toBeUndefined();
  });
});

describe('isValidTrackId', () => {
  it('accepts only the module id scheme', () => {
    expect(isValidTrackId('embedded-2')).toBe(true);
    expect(isValidTrackId('external-0123456789abcdef')).toBe(true);
    expect(isValidTrackId('embedded-2/../../etc/passwd')).toBe(false);
    expect(isValidTrackId('../secret')).toBe(false);
    expect(isValidTrackId('external-XYZ')).toBe(false);
    expect(isValidTrackId('external-0123456789abcde')).toBe(false); // 15 hex
  });
});

describe('listSubtitles', () => {
  it('merges embedded and external tracks with classification and parsed flags', async () => {
    const tracks = await listSubtitles(movieMediaFile(), { mediaRoots: [mediaRoot] });

    const embedded = tracks.filter((t) => t.source === 'embedded');
    const external = tracks.filter((t) => t.source === 'external');
    expect(embedded).toHaveLength(1);
    expect(external).toHaveLength(3);

    expect(embedded[0]).toMatchObject({
      id: `embedded-${embeddedStreams[0]?.streamIndex}`,
      source: 'embedded',
      kind: 'text',
      format: 'srt',
      language: 'eng',
      title: 'English',
      forced: true,
    });

    const en = external.find((t) => t.language === 'en');
    const fr = external.find((t) => t.language === 'fr');
    const vtt = external.find((t) => t.format === 'vtt');
    expect(en).toMatchObject({ format: 'srt', forced: false, kind: 'text' });
    expect(fr).toMatchObject({ format: 'srt', forced: true, kind: 'text' });
    expect(vtt).toMatchObject({ format: 'vtt', language: undefined });
    // Every external id is the stable external-<hash> scheme, no path leaked.
    for (const track of external) {
      expect(track.id).toMatch(/^external-[0-9a-f]{16}$/);
      expect(track).not.toHaveProperty('sidecarPath');
    }
  });

  it('classifies an embedded image (PGS) track as image', async () => {
    const tracks = await listSubtitles(
      movieMediaFile({
        subtitleStreams: [
          {
            streamIndex: 0,
            codec: 'hdmv_pgs_subtitle',
            language: 'eng',
            title: null,
            forced: false,
            default: false,
          },
        ],
      }),
      { mediaRoots: [mediaRoot] },
    );
    const embedded = tracks.find((t) => t.id === 'embedded-0');
    expect(embedded).toMatchObject({ kind: 'image', format: 'pgs' });
  });

  it('discovers no external tracks when the video is outside the media roots', async () => {
    const tracks = await listSubtitles(movieMediaFile(), { mediaRoots: [outsideDir] });
    // Embedded still listed from the (DB) input; external discovery is skipped.
    expect(tracks.every((t) => t.source === 'embedded')).toBe(true);
  });
});

describe('resolveBurnSubtitle', () => {
  it('resolves an embedded TEXT track to its subtitle-relative stream index', async () => {
    const file = movieMediaFile();
    const [track] = await listSubtitles(file, { mediaRoots: [mediaRoot] });
    const resolved = await resolveBurnSubtitle(file, track!.id, { mediaRoots: [mediaRoot] });
    expect(resolved).toMatchObject({ source: 'embedded', kind: 'text', subtitleIndex: 0 });
    expect(resolved.sidecarPath).toBeUndefined();
  });

  it('resolves an embedded IMAGE (PGS) track as image with its index', async () => {
    const file = movieMediaFile({
      subtitleStreams: [
        {
          streamIndex: 3,
          codec: 'hdmv_pgs_subtitle',
          language: 'eng',
          title: null,
          forced: false,
          default: false,
        },
      ],
    });
    const resolved = await resolveBurnSubtitle(file, 'embedded-3', { mediaRoots: [mediaRoot] });
    expect(resolved).toMatchObject({ source: 'embedded', kind: 'image', subtitleIndex: 0 });
  });

  it('resolves an external sidecar to a media-root-validated absolute path', async () => {
    const file = movieMediaFile();
    const tracks = await listSubtitles(file, { mediaRoots: [mediaRoot] });
    const external = tracks.find((t) => t.source === 'external' && t.format === 'srt');
    const resolved = await resolveBurnSubtitle(file, external!.id, { mediaRoots: [mediaRoot] });
    expect(resolved.source).toBe('external');
    expect(resolved.kind).toBe('text');
    expect(resolved.sidecarPath).toBeDefined();
    expect(path.isAbsolute(resolved.sidecarPath!)).toBe(true);
    expect(resolved.sidecarPath!.startsWith(mediaRoot)).toBe(true);
  });

  it('throws SubtitleNotFoundError for a malformed or unknown trackId', async () => {
    const file = movieMediaFile();
    for (const bad of ['', 'nope', '../etc', 'embedded-x', 'external-zzzz']) {
      await expect(
        resolveBurnSubtitle(file, bad, { mediaRoots: [mediaRoot] }),
      ).rejects.toBeInstanceOf(SubtitleNotFoundError);
    }
    // Well-formed but not a real stream of this file.
    await expect(
      resolveBurnSubtitle(file, 'embedded-99', { mediaRoots: [mediaRoot] }),
    ).rejects.toBeInstanceOf(SubtitleNotFoundError);
  });
});

describe('extractWebVtt: text conversion', () => {
  it('extracts an embedded srt track to valid WebVTT with cue text', async () => {
    const mediaFile = movieMediaFile();
    const trackId = `embedded-${embeddedStreams[0]?.streamIndex}`;

    const vtt = await extractWebVtt(mediaFile, trackId, {
      mediaRoots: [mediaRoot],
      transcodeDir,
    });

    expect(hasWebVttHeader(vtt)).toBe(true);
    expect(vtt).toContain('Hello');
    expect(vtt).toContain('World');
  });

  it('converts an external .srt sidecar to WebVTT', async () => {
    const mediaFile = movieMediaFile();
    const tracks = await listSubtitles(mediaFile, { mediaRoots: [mediaRoot] });
    const en = tracks.find((t) => t.source === 'external' && t.language === 'en');
    expect(en).toBeDefined();

    const vtt = await extractWebVtt(mediaFile, en!.id, { mediaRoots: [mediaRoot], transcodeDir });

    expect(hasWebVttHeader(vtt)).toBe(true);
    expect(vtt).toContain('Sidecar English');
  });

  it('passes an external .vtt through unchanged without invoking ffmpeg', async () => {
    const mediaFile = movieMediaFile();
    const tracks = await listSubtitles(mediaFile, { mediaRoots: [mediaRoot] });
    const vttTrack = tracks.find((t) => t.format === 'vtt');
    const convert = vi.fn<WebVttConverter>(ffmpegWebVttConverter);

    const vtt = await extractWebVtt(mediaFile, vttTrack!.id, {
      mediaRoots: [mediaRoot],
      transcodeDir,
      convert,
      useCache: false,
    });

    expect(vtt).toContain('External cue');
    expect(hasWebVttHeader(vtt)).toBe(true);
    expect(convert).not.toHaveBeenCalled();
  });
});

describe('extractWebVtt: caching', () => {
  it('reuses the cached VTT on the second call and does not re-run ffmpeg', async () => {
    const mediaFile = movieMediaFile({ id: `cache-${randomUUID().slice(0, 8)}` });
    const trackId = `embedded-${embeddedStreams[0]?.streamIndex}`;
    const convert = vi.fn<WebVttConverter>(ffmpegWebVttConverter);

    const first = await extractWebVtt(mediaFile, trackId, {
      mediaRoots: [mediaRoot],
      transcodeDir,
      convert,
    });
    expect(convert).toHaveBeenCalledTimes(1);

    // The cache file exists after the first extraction.
    const cachePath = path.join(transcodeDir, 'subtitles', mediaFile.id, `${trackId}.vtt`);
    await expect(access(cachePath)).resolves.toBeUndefined();

    const second = await extractWebVtt(mediaFile, trackId, {
      mediaRoots: [mediaRoot],
      transcodeDir,
      convert,
    });
    expect(convert).toHaveBeenCalledTimes(1); // not re-run
    expect(second).toBe(first);
  });
});

describe('extractWebVtt: error paths', () => {
  it('throws ImageSubtitleError for an image (PGS) track', async () => {
    const mediaFile = movieMediaFile({
      subtitleStreams: [
        {
          streamIndex: 0,
          codec: 'hdmv_pgs_subtitle',
          language: 'eng',
          title: null,
          forced: false,
          default: false,
        },
      ],
    });
    const convert = vi.fn<WebVttConverter>(ffmpegWebVttConverter);

    await expect(
      extractWebVtt(mediaFile, 'embedded-0', { mediaRoots: [mediaRoot], transcodeDir, convert }),
    ).rejects.toBeInstanceOf(ImageSubtitleError);
    expect(convert).not.toHaveBeenCalled();
  });

  it('rejects a traversal trackId without touching ffmpeg or the filesystem', async () => {
    const mediaFile = movieMediaFile();
    const convert = vi.fn<WebVttConverter>(ffmpegWebVttConverter);

    for (const bad of ['../../etc/passwd', 'embedded-0/../../x', 'external-..', '..']) {
      await expect(
        extractWebVtt(mediaFile, bad, { mediaRoots: [mediaRoot], transcodeDir, convert }),
      ).rejects.toBeInstanceOf(SubtitleNotFoundError);
    }
    expect(convert).not.toHaveBeenCalled();
  });

  it('throws SubtitleNotFoundError for an unknown but well-formed track id', async () => {
    const mediaFile = movieMediaFile();
    await expect(
      extractWebVtt(mediaFile, 'embedded-99', { mediaRoots: [mediaRoot], transcodeDir }),
    ).rejects.toBeInstanceOf(SubtitleNotFoundError);
  });

  it('throws SubtitleConversionError for an external .vtt missing its header', async () => {
    const badVttDir = path.join(mediaRoot, 'badvtt');
    await mkdir(badVttDir, { recursive: true });
    const video = path.join(badVttDir, 'Bad.mkv');
    // A real (tiny) video so discovery resolves its directory.
    // prettier-ignore
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      video,
    ]);
    await writeFile(path.join(badVttDir, 'Bad.vtt'), 'NOT A VTT FILE\n', 'utf8');

    const mediaFile: SubtitleMediaFile = { id: 'badvtt1', path: video, subtitleStreams: [] };
    const tracks = await listSubtitles(mediaFile, { mediaRoots: [mediaRoot] });
    const vttTrack = tracks.find((t) => t.format === 'vtt');
    expect(vttTrack).toBeDefined();

    await expect(
      extractWebVtt(mediaFile, vttTrack!.id, {
        mediaRoots: [mediaRoot],
        transcodeDir,
        useCache: false,
      }),
    ).rejects.toBeInstanceOf(SubtitleConversionError);
  });
});

describe('external discovery: path safety', () => {
  it('ignores a decoy sidecar sitting above the media root', async () => {
    const decoyRoot = path.join(tempDir, 'decoy-media');
    await mkdir(decoyRoot, { recursive: true });
    const video = path.join(decoyRoot, 'Solo.mkv');
    // prettier-ignore
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      video,
    ]);
    // Legit sidecar inside the root, decoy in the PARENT (above the root).
    await writeFile(path.join(decoyRoot, 'Solo.en.srt'), '1\n00:00:00,000 --> 00:00:01,000\nA\n');
    await writeFile(path.join(tempDir, 'Solo.de.srt'), '1\n00:00:00,000 --> 00:00:01,000\nB\n');

    const tracks = await listSubtitles(
      { id: 'solo1', path: video, subtitleStreams: [] },
      { mediaRoots: [decoyRoot] },
    );
    const external = tracks.filter((t) => t.source === 'external');
    expect(external).toHaveLength(1);
    expect(external[0]?.language).toBe('en');
    expect(external.some((t) => t.language === 'de')).toBe(false);
  });

  it('ignores a sidecar symlink that escapes the media root', async () => {
    const linkRoot = path.join(tempDir, 'link-media');
    await mkdir(linkRoot, { recursive: true });
    const video = path.join(linkRoot, 'Linked.mkv');
    // prettier-ignore
    await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      video,
    ]);
    const secret = path.join(outsideDir, 'secret.srt');
    await writeFile(secret, '1\n00:00:00,000 --> 00:00:01,000\nSecret\n');
    // A sidecar-named symlink pointing outside the roots.
    await symlink(secret, path.join(linkRoot, 'Linked.en.srt'));

    const tracks = await listSubtitles(
      { id: 'linked1', path: video, subtitleStreams: [] },
      { mediaRoots: [linkRoot] },
    );
    expect(tracks.filter((t) => t.source === 'external')).toHaveLength(0);

    await unlink(secret);
  });
});
