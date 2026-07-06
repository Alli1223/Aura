import { z } from 'zod';

import { qualityNameSchema } from '../streaming/quality-ladder.js';

// Validation + shape for per-user playback preferences (user-settings). These
// are purely UI defaults consumed by the web player; the authoritative
// server-side caps (max quality, parental controls, library grants) are still
// enforced on the streaming/media routes regardless of what a user prefers.

/**
 * A preferred subtitle language: a short language code (ISO 639, 2-8 letters,
 * e.g. "en"/"eng") or the sentinel "off" (never auto-enable subtitles). Trimmed
 * and lower-cased so matching against a track's language is case-insensitive.
 * Use `null` (not this schema) to clear the preference.
 */
export const subtitleLanguageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,8}$/, 'preferredSubtitleLanguage must be a short language code or "off"');

/**
 * The three playback-preference fields, each optional so a client can PATCH any
 * subset; `null` clears a field (falls back to the server/player default).
 * `preferredQuality` is validated against the quality ladder rung names.
 */
export const playbackPreferencesSchema = z.object({
  preferredQuality: qualityNameSchema.nullable().optional(),
  preferredSubtitleLanguage: subtitleLanguageSchema.nullable().optional(),
  autoplayNextEpisode: z.boolean('autoplayNextEpisode must be a boolean').optional(),
});

export type PlaybackPreferencesInput = z.infer<typeof playbackPreferencesSchema>;
