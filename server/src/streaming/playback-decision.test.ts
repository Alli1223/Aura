import { describe, expect, it } from 'vitest';

import {
  chooseTranscodeQuality,
  clientCapabilitiesSchema,
  decidePlayback,
  webBrowserProfile,
  type ClientCapabilities,
  type DecisionFile,
  type DecisionStream,
} from './playback-decision.js';

// Pure unit tests for the playback decision engine — no DB, no ffmpeg. Files
// and streams are plain objects shaped like MediaFile / MediaStream rows.

/** A comfortably-direct-playable h264/aac/mp4 1080p file. */
function directFile(overrides: Partial<DecisionFile> = {}): DecisionFile {
  return {
    container: 'mov,mp4,m4a,3gp,3g2,mj2', // ffprobe's real format_name for .mp4
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    bitrate: 4_000_000,
    ...overrides,
  };
}

function audio(codec: string): DecisionStream {
  return { type: 'audio', codec };
}
function video(codec: string): DecisionStream {
  return { type: 'video', codec };
}

describe('webBrowserProfile', () => {
  it('is the conservative h264/aac + mp4/webm + 1080p baseline', () => {
    expect(webBrowserProfile()).toEqual({
      containers: ['mp4', 'webm'],
      videoCodecs: ['h264'],
      audioCodecs: ['aac'],
      maxWidth: 1920,
      maxHeight: 1080,
    });
  });
});

describe('clientCapabilitiesSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(clientCapabilitiesSchema.parse({})).toEqual({});
  });

  it('rejects non-positive dimensions and bitrates', () => {
    expect(clientCapabilitiesSchema.safeParse({ maxWidth: 0 }).success).toBe(false);
    expect(clientCapabilitiesSchema.safeParse({ maxBitrate: -1 }).success).toBe(false);
    expect(clientCapabilitiesSchema.safeParse({ maxHeight: 1.5 }).success).toBe(false);
  });

  it('accepts a full capability set', () => {
    const caps = {
      containers: ['mp4', 'mkv'],
      videoCodecs: ['h264', 'hevc'],
      audioCodecs: ['aac', 'ac3'],
      maxWidth: 3840,
      maxHeight: 2160,
      maxBitrate: 40_000_000,
    };
    expect(clientCapabilitiesSchema.parse(caps)).toEqual(caps);
  });
});

describe('decidePlayback — direct play', () => {
  it('direct-plays h264/aac/mp4 within caps', () => {
    const decision = decidePlayback({
      file: directFile(),
      streams: [video('h264'), audio('aac')],
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('direct');
    expect(decision.transcodeReason).toBeUndefined();
    expect(decision.quality).toBeUndefined();
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('direct-plays a video that has no audio stream at all', () => {
    const decision = decidePlayback({
      file: directFile(),
      streams: [video('h264')],
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('direct');
  });

  it('treats "hevc"/"h265" and "matroska"/"mkv" as aliases when the client lists them', () => {
    const decision = decidePlayback({
      file: directFile({ container: 'matroska,webm', videoCodec: 'hevc' }),
      streams: [audio('ac3')],
      client: { containers: ['mkv'], videoCodecs: ['h265'], audioCodecs: ['ac3'] },
    });
    expect(decision.action).toBe('direct');
  });
});

describe('decidePlayback — transcode reasons', () => {
  it('transcodes an unsupported container with reason "container"', () => {
    const decision = decidePlayback({
      file: directFile({ container: 'matroska,webm' }), // canonical mkv
      streams: [video('h264'), audio('aac')],
      client: webBrowserProfile(), // only mp4/webm
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('container');
  });

  it('transcodes hevc video with reason "video-codec"', () => {
    const decision = decidePlayback({
      file: directFile({ videoCodec: 'hevc' }),
      streams: [video('hevc'), audio('aac')],
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('video-codec');
  });

  it('transcodes ac3/dts audio with reason "audio-codec"', () => {
    for (const codec of ['ac3', 'dts', 'eac3', 'truehd']) {
      const decision = decidePlayback({
        file: directFile(),
        streams: [video('h264'), audio(codec)],
        client: webBrowserProfile(),
      });
      expect(decision.action, codec).toBe('transcode');
      expect(decision.transcodeReason, codec).toBe('audio-codec');
    }
  });

  it('transcodes a 4K source for a 1080p client with reason "resolution", capped at 1080p', () => {
    const decision = decidePlayback({
      file: directFile({ width: 3840, height: 2160 }),
      streams: [video('h264'), audio('aac')],
      client: webBrowserProfile(), // 1920x1080
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('resolution');
    expect(decision.quality).toBe('1080p');
  });

  it('transcodes a high-bitrate source with reason "bitrate", capped down the ladder', () => {
    const decision = decidePlayback({
      file: directFile({ bitrate: 25_000_000 }),
      streams: [video('h264'), audio('aac')],
      client: { ...webBrowserProfile(), maxBitrate: 2_000_000 },
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('bitrate');
    // Only the 480p rung (1.4 Mbps) fits under a 2 Mbps ceiling.
    expect(decision.quality).toBe('480p');
  });

  it('never upscales: a 480p source that must transcode stays at 480p', () => {
    const decision = decidePlayback({
      // 480p source in an mkv (container forces the transcode), unconstrained
      // otherwise — must NOT be pushed up to 720p.
      file: directFile({ container: 'matroska,webm', width: 854, height: 480 }),
      streams: [video('h264'), audio('aac')],
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('container');
    expect(decision.quality).toBe('480p');
  });

  it('clamps the transcode quality to a per-user maxQuality cap', () => {
    // A 4K source for a 1080p client would transcode to 1080p, but a user capped
    // at 480p must never be handed anything above 480p.
    const decision = decidePlayback({
      file: directFile({ width: 3840, height: 2160 }),
      streams: [video('h264'), audio('aac')],
      client: webBrowserProfile(),
      maxQuality: '480p',
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('resolution');
    expect(decision.quality).toBe('480p');
  });

  it('reports every failing check in reasons and transcodeReasons (precedence-ordered)', () => {
    const decision = decidePlayback({
      file: directFile({
        container: 'matroska,webm',
        videoCodec: 'hevc',
        width: 3840,
        height: 2160,
      }),
      streams: [video('hevc'), audio('dts')],
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReasons).toEqual([
      'container',
      'video-codec',
      'audio-codec',
      'resolution',
    ]);
    expect(decision.transcodeReason).toBe('container'); // highest precedence
    expect(decision.reasons).toHaveLength(4);
  });
});

describe('decidePlayback — multi-audio & conservative defaults', () => {
  it('direct-plays when ANY audio track is playable', () => {
    const decision = decidePlayback({
      file: directFile(),
      streams: [video('h264'), audio('ac3'), audio('aac')], // one incompatible, one fine
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('direct');
  });

  it('transcodes when NO audio track is playable', () => {
    const decision = decidePlayback({
      file: directFile(),
      streams: [video('h264'), audio('ac3'), audio('dts')],
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('audio-codec');
  });

  it('an omitted client applies the conservative browser profile (direct for h264/aac/mp4)', () => {
    const decision = decidePlayback({
      file: directFile(),
      streams: [video('h264'), audio('aac')],
      // no client at all
    });
    expect(decision.action).toBe('direct');
  });

  it('an empty client object is treated the same as the browser profile', () => {
    const hevc = decidePlayback({
      file: directFile({ videoCodec: 'hevc' }),
      streams: [video('hevc'), audio('aac')],
      client: {} as ClientCapabilities,
    });
    expect(hevc.action).toBe('transcode');
    expect(hevc.transcodeReason).toBe('video-codec');
  });

  it('partial capabilities fill only the omitted fields from the profile', () => {
    // Client explicitly plays hevc but omits containers/audio -> those come
    // from the browser profile (mp4/webm + aac), so an hevc/mp4/aac file is
    // direct-playable.
    const decision = decidePlayback({
      file: directFile({ videoCodec: 'hevc' }),
      streams: [video('hevc'), audio('aac')],
      client: { videoCodecs: ['h264', 'hevc'] },
    });
    expect(decision.action).toBe('direct');
  });

  it('conservatively transcodes when the container is unknown', () => {
    const decision = decidePlayback({
      file: directFile({ container: null }),
      streams: [video('h264'), audio('aac')],
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('container');
  });

  it('conservatively transcodes when the video codec is unknown', () => {
    const decision = decidePlayback({
      file: directFile({ videoCodec: null }),
      streams: [audio('aac')], // no video stream to fall back to either
      client: webBrowserProfile(),
    });
    expect(decision.action).toBe('transcode');
    expect(decision.transcodeReason).toBe('video-codec');
  });
});

describe('chooseTranscodeQuality', () => {
  it('defaults to 720p when completely unconstrained', () => {
    expect(chooseTranscodeQuality({})).toBe('720p');
  });

  it('caps to the client resolution for a huge source', () => {
    expect(
      chooseTranscodeQuality({
        sourceWidth: 3840,
        sourceHeight: 2160,
        maxWidth: 1920,
        maxHeight: 1080,
      }),
    ).toBe('1080p');
    expect(
      chooseTranscodeQuality({
        sourceWidth: 3840,
        sourceHeight: 2160,
        maxWidth: 1280,
        maxHeight: 720,
      }),
    ).toBe('720p');
  });

  it('never picks a rung larger than the source (no upscaling)', () => {
    expect(chooseTranscodeQuality({ sourceWidth: 854, sourceHeight: 480 })).toBe('480p');
    expect(chooseTranscodeQuality({ sourceWidth: 1280, sourceHeight: 720 })).toBe('720p');
  });

  it('caps down the ladder by bitrate', () => {
    expect(chooseTranscodeQuality({ maxBitrate: 2_000_000 })).toBe('480p');
    expect(chooseTranscodeQuality({ maxBitrate: 5_000_000 })).toBe('720p');
    expect(chooseTranscodeQuality({ maxBitrate: 10_000_000 })).toBe('1080p');
  });

  it('floors at the smallest rung when limits are below it', () => {
    expect(chooseTranscodeQuality({ sourceWidth: 320, sourceHeight: 240 })).toBe('360p');
    expect(chooseTranscodeQuality({ maxBitrate: 100_000 })).toBe('360p');
  });

  it('clamps the chosen rung down to maxQuality (per-user cap)', () => {
    // Unconstrained would be 720p; a 480p cap drags it down to 480p.
    expect(chooseTranscodeQuality({ maxQuality: '480p' })).toBe('480p');
    // A 4K source for a 1080p client would be 1080p; a 720p cap lowers it.
    expect(
      chooseTranscodeQuality({
        sourceWidth: 3840,
        sourceHeight: 2160,
        maxWidth: 1920,
        maxHeight: 1080,
        maxQuality: '720p',
      }),
    ).toBe('720p');
  });

  it('never raises the chosen rung when maxQuality is above the honest choice', () => {
    // A 480p source stays 480p even though the cap would allow 1080p.
    expect(
      chooseTranscodeQuality({ sourceWidth: 854, sourceHeight: 480, maxQuality: '1080p' }),
    ).toBe('480p');
  });
});
