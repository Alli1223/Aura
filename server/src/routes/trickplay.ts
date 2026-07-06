import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { assertMediaItemAccess, ITEM_NOT_FOUND_MESSAGE } from '../auth/access.js';
import { toAuthUser, type AuthUser } from '../auth/types.js';
import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { ApiError, notFoundError } from '../lib/errors.js';
import {
  ensureTrickplay,
  resolveSpritePath,
  trickplayCacheRoot,
  TrickplayUnavailableError,
  type TrickplayFile,
  type TrickplayManifest,
} from '../media/trickplay.js';
import { verifyStreamToken } from '../streaming/stream-tokens.js';

// Trickplay (scrub-preview sprite) endpoints, registered on the /api/stream
// prefix alongside direct-play/HLS/subtitles. Identical auth chain: a signed
// streaming token scoped to exactly this media file, the token's user loaded
// fresh (deleted => 401, disabled => 403), and library access re-checked at use
// time via assertMediaItemAccess with the 404 enumeration cloak.
//
//   GET /api/stream/trickplay/:mediaFileId/manifest?token=  -> JSON tile map
//                                                              (generated on demand)
//   GET /api/stream/trickplay/:mediaFileId/:sprite?token=   -> a sprite JPEG
//
// When trickplay is disabled (TRICKPLAY_ENABLED=false) or cannot be produced
// for a file, every route answers 404 — a scrub preview is best-effort.

export interface TrickplayRoutesOptions {
  config: Config;
  /** The dedicated streaming-token HMAC secret from secrets.json. */
  streamTokenSecret: string;
}

/** One uniform 401 for every token failure (absent/malformed/expired/wrong file). */
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

interface TrickplayFileRow {
  id: string;
  mediaItemId: string;
  path: string;
  width: number | null;
  height: number | null;
  size: bigint;
  mtimeMs: bigint;
}

/** Coalesces concurrent on-demand generations of the same file into one run. */
const inFlight = new Map<string, Promise<TrickplayManifest>>();

export const trickplayRoutes: FastifyPluginAsync<TrickplayRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();
  const cacheRoot = trickplayCacheRoot(opts.config.CONFIG_DIR);

  /**
   * Verifies the token, requires it scoped to `mediaFileId`, loads the user
   * fresh (deleted => 401, disabled => 403) then the media file, and re-checks
   * library access at use time. The missing-file 404 is byte-identical to the
   * ungranted-library 404 (enumeration cloak).
   */
  const authenticateAndLoad = async (
    request: FastifyRequest,
    mediaFileId: string,
  ): Promise<{ user: AuthUser; file: TrickplayFileRow }> => {
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
      select: {
        id: true,
        mediaItemId: true,
        path: true,
        width: true,
        height: true,
        size: true,
        mtimeMs: true,
      },
    });
    if (file === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    await assertMediaItemAccess(user, file.mediaItemId);
    return { user, file };
  };

  const toTrickplayFile = (file: TrickplayFileRow): TrickplayFile => ({
    id: file.id,
    path: file.path,
    width: file.width,
    height: file.height,
    sizeBytes: Number(file.size),
    mtimeMs: Number(file.mtimeMs),
  });

  /** Ensures the file's sprites exist, coalescing concurrent generations. */
  const ensure = async (file: TrickplayFileRow): Promise<TrickplayManifest> => {
    const existing = inFlight.get(file.id);
    if (existing !== undefined) return existing;
    const promise = ensureTrickplay(toTrickplayFile(file), {
      cacheRoot,
      mediaRoots: opts.config.MEDIA_ROOTS,
      intervalSec: opts.config.TRICKPLAY_INTERVAL_SEC,
      thumbWidth: opts.config.TRICKPLAY_THUMB_WIDTH,
    }).finally(() => {
      inFlight.delete(file.id);
    });
    inFlight.set(file.id, promise);
    return promise;
  };

  /**
   * Returns the trickplay manifest for a media file, generating the sprites on
   * demand if they are missing or stale. 404 when trickplay is disabled or a
   * preview cannot be produced for this file.
   */
  app.get('/trickplay/:mediaFileId/manifest', async (request, reply) => {
    const { mediaFileId } = request.params as { mediaFileId: string };
    const { file } = await authenticateAndLoad(request, mediaFileId);

    if (!opts.config.TRICKPLAY_ENABLED) throw notFoundError('Not found');

    let manifest: TrickplayManifest;
    try {
      manifest = await ensure(file);
    } catch (err) {
      if (err instanceof TrickplayUnavailableError) {
        request.log.debug({ mediaFileId, reason: err.reason }, 'trickplay unavailable');
        throw notFoundError('Not found');
      }
      throw err;
    }

    void reply.header('cache-control', 'private, max-age=0');
    return reply.send(manifest);
  });

  /**
   * Serves one sprite sheet as image/jpeg. The filename is validated against a
   * strict allowlist and its resolved path is asserted to stay inside the
   * file's cache directory (defence in depth against traversal). An unknown
   * sprite cloaks to 404.
   */
  app.get('/trickplay/:mediaFileId/:sprite', async (request, reply) => {
    const { mediaFileId, sprite } = request.params as { mediaFileId: string; sprite: string };
    await authenticateAndLoad(request, mediaFileId);

    if (!opts.config.TRICKPLAY_ENABLED) throw notFoundError('Not found');

    const spritePath = resolveSpritePath(cacheRoot, mediaFileId, sprite);
    if (spritePath === undefined) throw notFoundError('Not found');

    let stats;
    try {
      stats = await stat(spritePath);
    } catch {
      throw notFoundError('Not found');
    }
    if (!stats.isFile()) throw notFoundError('Not found');

    void reply.header('content-type', 'image/jpeg');
    void reply.header('cache-control', 'private, max-age=0');
    void reply.header('content-length', stats.size);
    if (request.method === 'HEAD') return reply.send();

    const stream = createReadStream(spritePath);
    stream.on('error', (err) => {
      request.log.debug({ err, mediaFileId, sprite }, 'trickplay sprite stream error');
    });
    return reply.send(stream);
  });
};
