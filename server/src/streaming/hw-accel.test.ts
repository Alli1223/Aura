import { describe, expect, it } from 'vitest';

import {
  buildEncoderPlan,
  DEFAULT_HW_ACCEL,
  DEFAULT_HWACCEL_DEVICE,
  HW_ACCEL_MODES,
  hwAccelModeSchema,
  isHwAccelError,
  isHwAccelMode,
  type EncoderPlan,
} from './hw-accel.js';

// Pure encoder-selection tests — no ffmpeg, no GPU. The hardware transcode
// paths are verified here at the ARGUMENT level (encoder, hwaccel flags, scale
// chain); they are never GPU-run in CI. The runtime backstop is the automatic
// software fallback exercised in hls-session.test.ts.

const DEVICE = '/dev/dri/renderD128';

describe('hw-accel constants & schema', () => {
  it('exposes exactly the five modes with software as the default', () => {
    expect(HW_ACCEL_MODES).toEqual(['none', 'auto', 'vaapi', 'nvenc', 'qsv']);
    expect(DEFAULT_HW_ACCEL).toBe('none');
    expect(DEFAULT_HWACCEL_DEVICE).toBe('/dev/dri/renderD128');
  });

  it('narrows only known modes', () => {
    for (const mode of HW_ACCEL_MODES) expect(isHwAccelMode(mode)).toBe(true);
    expect(isHwAccelMode('vulkan')).toBe(false);
    expect(isHwAccelMode('')).toBe(false);
    expect(isHwAccelMode('NONE')).toBe(false);
  });

  it('zod schema accepts every mode and rejects anything else', () => {
    for (const mode of HW_ACCEL_MODES) expect(hwAccelModeSchema.parse(mode)).toBe(mode);
    expect(hwAccelModeSchema.safeParse('gpu').success).toBe(false);
    expect(hwAccelModeSchema.safeParse(1).success).toBe(false);
  });
});

describe('buildEncoderPlan', () => {
  it('software (none) plan matches the historical libx264 pipeline', () => {
    const plan = buildEncoderPlan('none', DEVICE);
    expect(plan.family).toBe('none');
    expect(plan.videoEncoder).toBe('libx264');
    expect(plan.hwaccelArgs).toEqual([]);
    expect(plan.videoCodecArgs).toEqual([
      '-preset',
      'veryfast',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
    ]);
    expect(plan.scaleFilter(1280)).toBe(`scale='min(iw,1280)':-2`);
    expect(plan.burnForcedSoftware).toBe(false);
  });

  it('honours a custom software preset and encoder', () => {
    const plan = buildEncoderPlan('none', DEVICE, {
      softwarePreset: 'slow',
      softwareEncoder: 'libx265',
    });
    expect(plan.videoEncoder).toBe('libx265');
    expect(plan.videoCodecArgs).toEqual([
      '-preset',
      'slow',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
    ]);
  });

  it('vaapi: h264_vaapi with device-bound hwaccel flags and scale_vaapi', () => {
    const plan = buildEncoderPlan('vaapi', DEVICE);
    expect(plan.family).toBe('vaapi');
    expect(plan.videoEncoder).toBe('h264_vaapi');
    expect(plan.hwaccelArgs).toEqual([
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      DEVICE,
      '-hwaccel_output_format',
      'vaapi',
    ]);
    // No preset / pix_fmt for hw (surface-format follows the GPU); profile kept.
    expect(plan.videoCodecArgs).toEqual(['-profile:v', 'high']);
    expect(plan.scaleFilter(1280)).toBe(`scale_vaapi=w='min(iw,1280)':h=-2`);
  });

  it('nvenc: h264_nvenc via CUDA, no device node, scale_cuda', () => {
    const plan = buildEncoderPlan('nvenc', DEVICE);
    expect(plan.family).toBe('nvenc');
    expect(plan.videoEncoder).toBe('h264_nvenc');
    expect(plan.hwaccelArgs).toEqual(['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']);
    // CUDA selects the GPU by index, so the DRM render node is NOT passed.
    expect(plan.hwaccelArgs).not.toContain(DEVICE);
    expect(plan.videoCodecArgs).toEqual(['-profile:v', 'high']);
    expect(plan.scaleFilter(1280)).toBe(`scale_cuda=w='min(iw,1280)':h=-2`);
  });

  it('qsv: h264_qsv with device-bound hwaccel flags and scale_qsv', () => {
    const plan = buildEncoderPlan('qsv', DEVICE);
    expect(plan.family).toBe('qsv');
    expect(plan.videoEncoder).toBe('h264_qsv');
    expect(plan.hwaccelArgs).toEqual([
      '-hwaccel',
      'qsv',
      '-hwaccel_device',
      DEVICE,
      '-hwaccel_output_format',
      'qsv',
    ]);
    expect(plan.scaleFilter(854)).toBe(`scale_qsv=w='min(iw,854)':h=-2`);
  });

  it('auto resolves to vaapi (hardware-preferred, with software fallback at runtime)', () => {
    const auto = buildEncoderPlan('auto', DEVICE);
    const vaapi = buildEncoderPlan('vaapi', DEVICE);
    expect(auto.family).toBe('vaapi');
    expect(auto.videoEncoder).toBe(vaapi.videoEncoder);
    expect(auto.hwaccelArgs).toEqual(vaapi.hwaccelArgs);
    expect(auto.scaleFilter(1920)).toBe(vaapi.scaleFilter(1920));
  });

  it('interpolates the given device into vaapi/qsv flags', () => {
    const dev = '/dev/dri/renderD129';
    expect(buildEncoderPlan('vaapi', dev).hwaccelArgs).toContain(dev);
    expect(buildEncoderPlan('qsv', dev).hwaccelArgs).toContain(dev);
  });

  it.each(['vaapi', 'nvenc', 'qsv', 'auto'] as const)(
    'a burn-in forces %s back to the software plan',
    (mode) => {
      const plan = buildEncoderPlan(mode, DEVICE, { hasBurnIn: true });
      expect(plan.family).toBe('none');
      expect(plan.videoEncoder).toBe('libx264');
      expect(plan.hwaccelArgs).toEqual([]);
      expect(plan.scaleFilter(1280)).toBe(`scale='min(iw,1280)':-2`);
      // Flag that a hardware request was downgraded (informational).
      expect(plan.burnForcedSoftware).toBe(true);
    },
  );

  it('a burn-in on the none mode is not "forced" (it was already software)', () => {
    const plan = buildEncoderPlan('none', DEVICE, { hasBurnIn: true });
    expect(plan.family).toBe('none');
    expect(plan.burnForcedSoftware).toBe(false);
  });

  it('never upscales: every scale chain caps width at min(iw, W)', () => {
    for (const mode of HW_ACCEL_MODES) {
      const chain = buildEncoderPlan(mode, DEVICE).scaleFilter(640);
      expect(chain, mode).toContain(`min(iw,640)`);
    }
  });

  it('produces no shell metacharacters in any emitted argument', () => {
    const injection = /[;&|`$<>\n\r]/;
    for (const mode of HW_ACCEL_MODES) {
      const plan: EncoderPlan = buildEncoderPlan(mode, DEVICE);
      const args = [
        plan.videoEncoder,
        ...plan.hwaccelArgs,
        ...plan.videoCodecArgs,
        ...HW_ACCEL_MODES.flatMap(() => [plan.scaleFilter(1920), plan.scaleFilter(854)]),
      ];
      for (const arg of args)
        expect(injection.test(arg), `${mode}: ${JSON.stringify(arg)}`).toBe(false);
    }
  });
});

describe('isHwAccelError', () => {
  const hwFailures = [
    'Failed to initialise VAAPI connection: -1 (unknown libva error).',
    '[h264_vaapi @ 0x55] No usable devices found for the given hwaccel',
    '[h264_nvenc @ 0x55] Cannot load libcuda.so.1',
    'Error creating a NVENC device',
    '[AVHWDeviceContext @ 0x55] Failed to create qsv device: -17.',
    'Error while opening encoder — cuda: no CUDA-capable device is detected',
    'Cannot load /dev/dri/renderD128',
    'Device creation failed: -22.',
    'Impossible to convert between the formats supported by the filter',
    '[hwupload @ 0x55] A hardware device reference is required',
  ];
  const nonHwFailures = [
    'moov atom not found',
    'Invalid data found when processing input',
    'Error opening input: Invalid argument',
    'Output file #0 does not contain any stream',
    'Conversion failed!',
    '',
  ];

  it.each(hwFailures)('flags a hardware/device failure: %s', (stderr) => {
    expect(isHwAccelError(stderr)).toBe(true);
  });

  it.each(nonHwFailures)('does NOT flag a non-hardware failure: %s', (stderr) => {
    expect(isHwAccelError(stderr)).toBe(false);
  });

  it('returns false for undefined stderr', () => {
    expect(isHwAccelError(undefined)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isHwAccelError('FAILED TO CREATE VAAPI DEVICE')).toBe(true);
    expect(isHwAccelError('Cannot Load libcuda.so.1')).toBe(true);
  });
});
