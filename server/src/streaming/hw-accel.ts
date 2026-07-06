import { z } from 'zod';

// Hardware-accelerated transcoding (hw-accel roadmap item).
//
// A PURE, dependency-free module (only zod) that maps a requested acceleration
// MODE to the concrete ffmpeg pieces the HLS transcoder needs: the video
// encoder (`-c:v`), the input-level `-hwaccel*` flags that must precede `-i`,
// the codec-level args that follow `-c:v`, and the scale filter expression.
//
// It is deliberately side-effect free (no filesystem, no spawning) so the whole
// encoder-selection matrix is exhaustively unit-testable without a GPU. The
// hardware paths are therefore ARG-LEVEL verified in CI (never GPU-run); the
// session manager's automatic software fallback (see hls-session.ts) is the
// runtime backstop that catches a machine where the requested device is absent
// or the driver rejects the pipeline.

/**
 * Selectable acceleration modes, in registry order:
 *  - `none`  — software libx264 (the safe default, always available).
 *  - `auto`  — "hardware-preferred": resolves to VAAPI (the most common Linux
 *              path) and relies on the automatic software fallback when no VAAPI
 *              device is actually usable.
 *  - `vaapi` — Intel/AMD VA-API (`h264_vaapi`) via a DRM render node.
 *  - `nvenc` — NVIDIA NVENC (`h264_nvenc`) via CUDA.
 *  - `qsv`   — Intel Quick Sync (`h264_qsv`).
 */
export const HW_ACCEL_MODES = ['none', 'auto', 'vaapi', 'nvenc', 'qsv'] as const;

/** A requested acceleration mode (what the setting stores). */
export type HwAccelMode = (typeof HW_ACCEL_MODES)[number];

/** A concrete encoder family — `auto` has already been resolved to one of these. */
export type EncoderFamily = 'none' | 'vaapi' | 'nvenc' | 'qsv';

/** Server-wide default acceleration mode: software (the universally-safe path). */
export const DEFAULT_HW_ACCEL: HwAccelMode = 'none';

/**
 * Default DRM render node used by VAAPI and QSV. Overridable via the
 * HWACCEL_DEVICE env (config.ts). Ignored by the NVENC/CUDA path, which selects
 * its GPU by index rather than a device node.
 */
export const DEFAULT_HWACCEL_DEVICE = '/dev/dri/renderD128';

/** zod schema accepting exactly a known acceleration mode. */
export const hwAccelModeSchema = z.enum(HW_ACCEL_MODES);

/** Narrows an arbitrary string to a known acceleration mode. */
export function isHwAccelMode(value: string): value is HwAccelMode {
  return (HW_ACCEL_MODES as readonly string[]).includes(value);
}

/**
 * The concrete ffmpeg encoder pieces for one transcode, produced by
 * buildEncoderPlan. buildHlsFfmpegArgs assembles these into the final arg array
 * around the (mode-independent) input mapping, bitrate caps, audio and HLS
 * muxing, all of which stay identical across modes.
 */
export interface EncoderPlan {
  /** The effective family after resolving `auto` and any burn-in downgrade. */
  family: EncoderFamily;
  /** Value for `-c:v` (e.g. `libx264`, `h264_vaapi`). */
  videoEncoder: string;
  /**
   * Input-level flags emitted BEFORE `-i` (empty for software). These select
   * the hwaccel and keep decoded frames on the GPU so the scale + encode stay
   * on the device.
   */
  hwaccelArgs: readonly string[];
  /**
   * Codec-level args emitted immediately after `-c:v <enc>` (preset / profile /
   * pixel format). Software keeps the historical `-preset .. -profile:v high
   * -pix_fmt yuv420p`; the hardware encoders keep `-profile:v high` only (their
   * pixel format follows the GPU surface, and their presets are vendor-specific
   * so the encoder default is used).
   */
  videoCodecArgs: readonly string[];
  /**
   * Builds the plain `-vf` scale expression for a width cap. Every mode caps
   * width at `min(iw, maxWidth)` (never upscales) and derives an even height
   * that preserves the aspect ratio — identical semantics to the software path,
   * expressed with each mode's scaler.
   */
  scaleFilter: (maxWidth: number) => string;
  /**
   * True when a burn-in subtitle was requested and forced this plan back to
   * software (see the burn-in rule below). Purely informational for logging.
   */
  burnForcedSoftware: boolean;
}

/** Options for buildEncoderPlan. */
export interface EncoderPlanOptions {
  /**
   * Whether a subtitle must be burned into the video. Compositing an overlay /
   * libass filtergraph across every GPU-surface pipeline is not implemented, so
   * ANY burn-in forces the whole transcode back to the proven software path —
   * correctness over cleverness. (Asserted in tests.)
   */
  hasBurnIn?: boolean;
  /** x264 preset for the software path. Defaults to `veryfast`. */
  softwarePreset?: string;
  /** Software encoder for the software path. Defaults to `libx264`. */
  softwareEncoder?: string;
}

/** `auto` is hardware-preferred → VAAPI; every other mode maps to itself. */
function resolveMode(mode: HwAccelMode): EncoderFamily {
  return mode === 'auto' ? 'vaapi' : mode;
}

/**
 * Maps a requested acceleration mode + device to the concrete encoder plan.
 * Pure and total: unknown-but-typed modes cannot occur (the enum guards inputs),
 * and any burn-in request degrades to software regardless of the mode.
 *
 * Per family:
 *  - `vaapi`: full-GPU pipeline — `-hwaccel vaapi -hwaccel_device <dev>
 *    -hwaccel_output_format vaapi` keeps frames on the device; `scale_vaapi`
 *    downscales on the GPU; `h264_vaapi` encodes. Bitrate caps (`-b:v/-maxrate/
 *    -bufsize`) are applied by buildHlsFfmpegArgs identically to software.
 *  - `nvenc`: `-hwaccel cuda -hwaccel_output_format cuda` + `scale_cuda` +
 *    `h264_nvenc`. The device node is NOT passed (CUDA selects by index).
 *  - `qsv`:   `-hwaccel qsv -hwaccel_device <dev> -hwaccel_output_format qsv` +
 *    `scale_qsv` + `h264_qsv`.
 *  - `none`:  software libx264 — byte-for-byte the historical pipeline.
 */
export function buildEncoderPlan(
  mode: HwAccelMode,
  device: string,
  options: EncoderPlanOptions = {},
): EncoderPlan {
  const hasBurnIn = options.hasBurnIn ?? false;
  const preset = options.softwarePreset ?? 'veryfast';
  const softwareEncoder = options.softwareEncoder ?? 'libx264';
  const burnForcedSoftware = hasBurnIn && mode !== 'none';

  // Burn-in always transcodes in software (see EncoderPlanOptions.hasBurnIn).
  const family: EncoderFamily = hasBurnIn ? 'none' : resolveMode(mode);

  switch (family) {
    case 'vaapi':
      return {
        family,
        videoEncoder: 'h264_vaapi',
        hwaccelArgs: [
          '-hwaccel',
          'vaapi',
          '-hwaccel_device',
          device,
          '-hwaccel_output_format',
          'vaapi',
        ],
        videoCodecArgs: ['-profile:v', 'high'],
        scaleFilter: (maxWidth) => `scale_vaapi=w='min(iw,${maxWidth})':h=-2`,
        burnForcedSoftware,
      };
    case 'nvenc':
      return {
        family,
        videoEncoder: 'h264_nvenc',
        hwaccelArgs: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
        videoCodecArgs: ['-profile:v', 'high'],
        scaleFilter: (maxWidth) => `scale_cuda=w='min(iw,${maxWidth})':h=-2`,
        burnForcedSoftware,
      };
    case 'qsv':
      return {
        family,
        videoEncoder: 'h264_qsv',
        hwaccelArgs: [
          '-hwaccel',
          'qsv',
          '-hwaccel_device',
          device,
          '-hwaccel_output_format',
          'qsv',
        ],
        videoCodecArgs: ['-profile:v', 'high'],
        scaleFilter: (maxWidth) => `scale_qsv=w='min(iw,${maxWidth})':h=-2`,
        burnForcedSoftware,
      };
    case 'none':
    default:
      return {
        family: 'none',
        videoEncoder: softwareEncoder,
        hwaccelArgs: [],
        videoCodecArgs: ['-preset', preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
        scaleFilter: (maxWidth) => `scale='min(iw,${maxWidth})':-2`,
        burnForcedSoftware,
      };
  }
}

/**
 * Substrings/patterns (case-insensitive) that mark an ffmpeg failure as caused
 * by the hardware pipeline (missing device, unusable driver, surface-format
 * mismatch) rather than the media itself. The session manager consults this on
 * a failed HARDWARE start to decide whether to retry once in software: a hit
 * triggers the fallback, a miss (a genuine input/codec error) does NOT, so a
 * non-hardware failure can never loop.
 *
 * Real hw failures reliably name their API (`vaapi`, `nvenc`, `cuda`, `qsv`,
 * `libva`, `libcuda`) or the device/upload machinery, so matching on those is
 * precise without swallowing ordinary decode errors.
 */
const HW_ERROR_PATTERNS: readonly RegExp[] = [
  /vaapi|libva|va[- ]?api/i,
  /nvenc|nvdec|cuvid/i,
  /\bcuda\b|libcuda|nvcuda/i,
  /\bqsv\b|quick ?sync/i,
  /vdpau/i,
  /hwaccel/i,
  /hwupload|hwdownload/i,
  /hardware (acceleration|encoder|device|frames)/i,
  /\/dev\/dri|renderd\d+/i,
  /cannot load/i,
  /no such device|no device available|no usable devices|device creation failed|error creating .*device|failed to (create|initiali[sz]e|open) .*device/i,
  /impossible to convert between the formats/i,
];

/**
 * True when an ffmpeg stderr tail looks like a hardware-acceleration failure
 * (and the automatic software fallback should therefore be attempted). Empty or
 * unrecognised stderr returns false so only clearly hardware-related failures
 * trigger a retry.
 */
export function isHwAccelError(stderr: string | undefined): boolean {
  if (stderr === undefined || stderr.length === 0) return false;
  return HW_ERROR_PATTERNS.some((pattern) => pattern.test(stderr));
}
