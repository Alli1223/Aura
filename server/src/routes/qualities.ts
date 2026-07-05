import type { FastifyPluginAsync } from 'fastify';

import { getSetting } from '../lib/settings.js';
import {
  clampQuality,
  effectiveMaxQuality,
  qualitiesUpTo,
} from '../streaming/quality-ladder.js';

// Playback quality options for the CURRENT user. The player's quality menu is
// built from this so it only ever offers rungs the user is permitted to select
// (their effective cap = min(personal cap, server cap)). Enforcement still
// happens server-side on the HLS/decide routes — this endpoint is purely so the
// UI does not present a level that would be silently downgraded.

export const qualityRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [app.authenticate] }, async (request) => {
    const [defaultQuality, serverMaxQuality] = await Promise.all([
      getSetting('defaultQuality', request.log),
      getSetting('maxQuality', request.log),
    ]);

    const maxQuality = effectiveMaxQuality(request.user.maxQuality, serverMaxQuality);

    return {
      // The highest rung this user may select.
      maxQuality,
      // The server default, clamped so the UI's default is always permitted.
      defaultQuality: clampQuality(defaultQuality, maxQuality),
      // Only the permitted rungs (cap and below), highest first.
      qualities: qualitiesUpTo(maxQuality).map((rung) => ({
        name: rung.name,
        maxWidth: rung.maxWidth,
        videoBitrate: rung.videoBitrate,
        audioBitrate: rung.audioBitrate,
      })),
    };
  });
};
