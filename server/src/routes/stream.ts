import { createReadStream } from 'node:fs';
import path from 'node:path';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { assertMediaItemAccess, ITEM_NOT_FOUND_MESSAGE } from '../auth/access.js';
import { toAuthUser } from '../auth/types.js';
import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { ApiError, notFoundError, sendError } from '../lib/errors.js';
import { resolveMediaFileForServing } from '../lib/media-roots.js';
import { parseBody } from '../lib/validation.js';
import {
  computeEtag,
  contentDispositionInline,
  contentTypeForPath,
  etagMatches,
  resolveRequestRange,
} from '../streaming/direct-play.js';
import { issueStreamToken, verifyStreamToken } from '../streaming/stream-tokens.js';

export interface StreamRoutesOptions {
  config: Config;
  /** The dedicated streaming-token HMAC secret from secrets.json. */
  streamTokenSecret: string;
}

const tokenBodySchema = z.object({
  mediaFileId: z.string('mediaFileId must be a string').min(1, 'mediaFileId is required'),
});

/**
 * One uniform 401 for every way a streaming token can fail to authenticate
 * (absent, malformed, bad signature, expired, wrong file, deleted user).
 * Uniformity is deliberate: the response never tells a URL holder WHY the
 * token stopped working.
 */
const TOKEN_INVALID_MESSAGE = 'Missing or invalid streaming token';

function tokenInvalidError(): ApiError {
  return new ApiError(401, 'TOKEN_INVALID', TOKEN_INVALID_MESSAGE);
}

/** The `?token=` query value, or undefined when absent/repeated/empty. */
function extractStreamToken(query: unknown): string | undefined {
  if (typeof query !== 'object' || query === null) return undefined;
  const { token } = query as Record<string, unknown>;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Streaming endpoints: token issuance plus the direct-play byte server. The
 * HLS transcode routes (later roadmap items) will follow the same pattern —
 * verify the token AND re-check library access per request, per the
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

  /**
   * Direct play: serves a media file's bytes with full HTTP range support so
   * `<video>` elements can seek. GET and HEAD (identical headers, no body).
   *
   * Auth chain, run on EVERY request in this order:
   *  1. verify the ?token= signature/expiry (401 TOKEN_INVALID otherwise);
   *  2. the token must be scoped to exactly this mediaFileId (401);
   *  3. the token's user is loaded fresh — deleted => 401, disabled => 403
   *     ACCOUNT_DISABLED;
   *  4. the media file row must exist (404, byte-identical to the access
   *     cloak below);
   *  5. library access is re-checked at use time via assertMediaItemAccess —
   *     tokens are stateless, so a grant revoked after issuance must stream
   *     nothing (statelessness contract in streaming/stream-tokens.ts).
   *
   * Path safety: the stored path is realpath-resolved fresh and must still
   * live inside a configured media root before the file is opened (a symlink
   * swapped in after scanning cannot escape). A vanished file responds with
   * the same cloaked 404 and best-effort marks the row "missing".
   */
  const handleDirectPlay = async (request: FastifyRequest, reply: FastifyReply) => {
    const { mediaFileId } = request.params as { mediaFileId: string };

    const token = extractStreamToken(request.query);
    if (token === undefined) throw tokenInvalidError();
    const verification = verifyStreamToken(token, opts.streamTokenSecret);
    if (!verification.ok) throw tokenInvalidError();
    if (verification.claims.mediaFileId !== mediaFileId) throw tokenInvalidError();

    const userRow = await prisma.user.findUnique({ where: { id: verification.claims.userId } });
    if (userRow === null) throw tokenInvalidError();
    if (!userRow.isEnabled) throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    const user = toAuthUser(userRow);

    const file = await prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { id: true, mediaItemId: true, path: true },
    });
    // Same enumeration cloak as the token route: missing id and ungranted
    // library are byte-identical 404s.
    if (file === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    await assertMediaItemAccess(user, file.mediaItemId);

    const resolution = await resolveMediaFileForServing(file.path, opts.config.MEDIA_ROOTS);
    if (!resolution.ok) {
      if (resolution.reason === 'missing') {
        // Best effort: streaming must not fail over a bookkeeping write.
        try {
          await prisma.mediaFile.update({ where: { id: file.id }, data: { status: 'missing' } });
        } catch (err) {
          request.log.debug({ err, mediaFileId: file.id }, 'could not mark media file missing');
        }
      }
      throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    }
    const { canonicalPath, stats } = resolution;
    const size = stats.size;
    const etag = computeEtag(size, stats.mtimeMs);

    // Headers shared by every outcome (200/206/304/416). Cache-Control
    // `private, max-age=0`: responses may be cached per-user but must be
    // revalidated before reuse, so seeks after a pause cost one cheap
    // If-None-Match 304 round trip instead of a re-download — while a file
    // that changed on disk (new size/mtime => new ETag) is never replayed
    // stale from cache.
    void reply.header('accept-ranges', 'bytes');
    void reply.header('etag', etag);
    void reply.header('last-modified', new Date(stats.mtimeMs).toUTCString());
    void reply.header('cache-control', 'private, max-age=0');

    const ifNoneMatch = request.headers['if-none-match'];
    if (etagMatches(ifNoneMatch, etag)) {
      return reply.code(304).send();
    }

    const range = resolveRequestRange(request.headers.range, size);
    if (range.kind === 'unsatisfiable') {
      void reply.header('content-range', `bytes */${size}`);
      return sendError(reply, 416, 'RANGE_NOT_SATISFIABLE', 'Requested range not satisfiable');
    }

    const contentLength = range.kind === 'range' ? range.end - range.start + 1 : size;

    void reply.code(range.kind === 'range' ? 206 : 200);
    void reply.header('content-type', contentTypeForPath(file.path));
    void reply.header('content-disposition', contentDispositionInline(path.basename(file.path)));
    void reply.header('content-length', contentLength);
    if (range.kind === 'range') {
      void reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
    }

    if (request.method === 'HEAD') {
      // Identical headers to GET, no body — and no file handle is opened.
      return reply.send();
    }

    // Open only AFTER every auth and path-safety check has passed, and open
    // the canonical path (the exact path that was containment-checked). The
    // full-body read passes no bounds (an empty file has no byte -1).
    const stream =
      range.kind === 'range'
        ? createReadStream(canonicalPath, { start: range.start, end: range.end })
        : createReadStream(canonicalPath);
    // Read errors after headers are sent (file truncated mid-stream, client
    // gone) cannot become an HTTP error response any more; log at debug and
    // let Fastify tear the socket down without crashing or spamming logs.
    stream.on('error', (err) => {
      request.log.debug({ err, mediaFileId: file.id }, 'direct play stream error');
    });
    return reply.send(stream);
  };

  app.route({
    method: ['GET', 'HEAD'],
    url: '/direct/:mediaFileId',
    handler: handleDirectPlay,
  });
};
