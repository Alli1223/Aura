import { z } from 'zod';

// The transcode quality ladder — the SINGLE SOURCE OF TRUTH for named quality
// rungs and every quality-selection/clamping decision in the server. Both the
// HLS session manager (hls-session.ts, which re-exports the compatibility
// symbols) and the playback decision engine (playback-decision.ts) consume this
// module so the rungs can never drift apart.
//
// Ordering: the ladder is DESCENDING (highest quality first). "Rank" is the
// index into that order, so a LOWER rank means a HIGHER quality (rank 0 =
// 1080p). Clamping to a cap therefore keeps whichever rung has the GREATER
// rank (the lower quality).

/**
 * All quality names, highest first. A readonly tuple so it can seed a zod enum
 * with literal types. Widths are caps: the transcoder never upscales a source
 * narrower than the cap.
 */
export const QUALITY_NAMES = ['1080p', '720p', '480p', '360p'] as const;

/** A known quality rung name. */
export type HlsQualityName = (typeof QUALITY_NAMES)[number];

/** One quality rung's encoding parameters (without its name). */
export interface HlsQuality {
  /** Maximum output width. The source is only ever downscaled to this. */
  readonly maxWidth: number;
  /** Target (average) video bitrate, e.g. "6000k". */
  readonly videoBitrate: string;
  /** VBV peak bitrate cap. */
  readonly maxrate: string;
  /** VBV buffer size. */
  readonly bufsize: string;
  /** Stereo AAC audio bitrate, e.g. "192k". */
  readonly audioBitrate: string;
}

/** A named rung: an HlsQuality plus its ladder name. */
export interface QualityRung extends HlsQuality {
  readonly name: HlsQualityName;
}

/**
 * The quality ladder, DESCENDING (highest first). Widths are caps
 * (min(iw, maxWidth) — never upscaling). Bitrates are software-x264 targets.
 * The order here must match QUALITY_NAMES.
 */
export const QUALITY_LADDER: readonly QualityRung[] = [
  {
    name: '1080p',
    maxWidth: 1920,
    videoBitrate: '6000k',
    maxrate: '6000k',
    bufsize: '12000k',
    audioBitrate: '192k',
  },
  {
    name: '720p',
    maxWidth: 1280,
    videoBitrate: '3000k',
    maxrate: '3000k',
    bufsize: '6000k',
    audioBitrate: '160k',
  },
  {
    name: '480p',
    maxWidth: 854,
    videoBitrate: '1400k',
    maxrate: '1400k',
    bufsize: '2800k',
    audioBitrate: '128k',
  },
  {
    name: '360p',
    maxWidth: 640,
    videoBitrate: '800k',
    maxrate: '800k',
    bufsize: '1600k',
    audioBitrate: '96k',
  },
];

/** All quality names, in descending order (derived from the ladder). */
export const HLS_QUALITY_NAMES: HlsQualityName[] = QUALITY_LADDER.map((rung) => rung.name);

/**
 * Named-rung lookup record derived from the ladder. Kept for the transcoder,
 * which selects a rung by name. Never diverges from QUALITY_LADDER.
 */
export const QUALITIES: Readonly<Record<HlsQualityName, HlsQuality>> = Object.fromEntries(
  QUALITY_LADDER.map((rung) => {
    const { name, ...quality } = rung;
    return [name, quality];
  }),
) as Record<HlsQualityName, HlsQuality>;

/** The highest rung (first in the descending ladder). */
export const HIGHEST_QUALITY: HlsQualityName = QUALITY_NAMES[0];

/** The lowest rung (last in the descending ladder). */
export const LOWEST_QUALITY: HlsQualityName = QUALITY_NAMES[QUALITY_NAMES.length - 1] as HlsQualityName;

/** Server-wide default selectable quality. */
export const DEFAULT_QUALITY: HlsQualityName = '720p';

/** Server-wide default maximum quality cap. */
export const DEFAULT_MAX_QUALITY: HlsQualityName = HIGHEST_QUALITY;

/** zod schema accepting exactly a ladder quality name. */
export const qualityNameSchema = z.enum(QUALITY_NAMES);

/** Narrows an arbitrary string to a known quality name. */
export function isHlsQualityName(value: string): value is HlsQualityName {
  return (QUALITY_NAMES as readonly string[]).includes(value);
}

/** The ladder rung with this name, or undefined for an unknown name. */
export function qualityByName(name: string): QualityRung | undefined {
  return QUALITY_LADDER.find((rung) => rung.name === name);
}

/**
 * The rung's rank: its index in the descending ladder. LOWER rank == HIGHER
 * quality. An unknown name ranks below every rung (Infinity) so it can never be
 * mistaken for a permitted high rung.
 */
function rank(name: string): number {
  const index = (QUALITY_NAMES as readonly string[]).indexOf(name);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/**
 * The rungs a user may select given an effective maximum: the cap rung and
 * every rung below it, in descending (ladder) order. An unknown cap yields the
 * whole ladder's floor only (defensive — should not happen for validated caps).
 */
export function qualitiesUpTo(maxName: HlsQualityName): QualityRung[] {
  const maxRank = rank(maxName);
  return QUALITY_LADDER.filter((rung) => rank(rung.name) >= maxRank);
}

/**
 * Clamps a requested quality to a maximum, ALWAYS returning a valid rung name
 * that does not exceed `maxName`:
 *  - requested higher than the cap  -> the cap;
 *  - requested at or below the cap   -> the requested rung unchanged;
 *  - requested unknown/invalid       -> the cap (the safest permitted rung).
 * This is the server-side guarantee: a client can never obtain a rung above its
 * cap, whatever it asks for.
 */
export function clampQuality(requested: string, maxName: HlsQualityName): HlsQualityName {
  const cap = qualityByName(maxName) === undefined ? DEFAULT_MAX_QUALITY : maxName;
  const req = qualityByName(requested);
  if (req === undefined) return cap;
  // A smaller rank == higher quality: if the request outranks the cap, clamp.
  return rank(req.name) < rank(cap) ? cap : req.name;
}

/**
 * The effective maximum quality for a user = min(userCap ?? serverCap,
 * serverCap) by ladder order. A null/undefined or unknown user cap falls back
 * to the server cap; a user cap ABOVE the server cap is clamped down to the
 * server cap (the server cap is a hard ceiling nobody can exceed).
 */
export function effectiveMaxQuality(
  userMaxQuality: string | null | undefined,
  serverMaxQuality: HlsQualityName,
): HlsQualityName {
  const server = qualityByName(serverMaxQuality) === undefined ? DEFAULT_MAX_QUALITY : serverMaxQuality;
  if (userMaxQuality === null || userMaxQuality === undefined) return server;
  const user = qualityByName(userMaxQuality);
  if (user === undefined) return server;
  // Greater rank == lower quality: the effective max is the lower of the two.
  return rank(user.name) > rank(server) ? user.name : server;
}
