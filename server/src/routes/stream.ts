import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { assertMediaItemAccess, ITEM_NOT_FOUND_MESSAGE } from '../auth/access.js';
import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { notFoundError } from '../lib/errors.js';
import { parseBody } from '../lib/validation.js';
import { issueStreamToken } from '../streaming/stream-tokens.js';

export interface StreamRoutesOptions {
  config: Config;
  /** The dedicated streaming-token HMAC secret from secrets.json. */
  streamTokenSecret: string;
}

const tokenBodySchema = z.object({
  mediaFileId: z.string('mediaFileId must be a string').min(1, 'mediaFileId is required'),
});

/**
 * Streaming endpoints. Today: token issuance only. The playback routes that
 * consume these tokens (direct play, HLS) live in later roadmap items and
 * must verify the token AND re-check library access per request — see the
 * statelessness contract in streaming/stream-tokens.ts.
 */
export const streamRoutes: FastifyPluginAsync<StreamRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();

  app.post('/token', { preHandler: app.authenticate }, async (request, reply) => {
    const body = parseBody(tokenBodySchema, request.body, reply);
    if (body === undefined) return reply;

    const file = await prisma.mediaFile.findUnique({
      where: { id: body.mediaFileId },
      select: { id: true, mediaItemId: true },
    });
    if (file === null) {
      // Enumeration cloak: byte-identical to the 404 assertMediaItemAccess
      // throws below for files in ungranted libraries, so the response never
      // reveals whether a media file id exists.
      throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    }
    await assertMediaItemAccess(request.user, file.mediaItemId);

    const { token, expiresAt } = issueStreamToken({
      userId: request.user.id,
      mediaFileId: file.id,
      secret: opts.streamTokenSecret,
      ttlMs: opts.config.STREAM_TOKEN_TTL_MS,
    });
    return reply.send({ token, expiresAt: expiresAt.toISOString() });
  });
};
