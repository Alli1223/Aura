import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { assertMediaItemAccess, ITEM_NOT_FOUND_MESSAGE } from '../auth/access.js';
import { toAuthUser, type AuthUser } from '../auth/types.js';
import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { ApiError, notFoundError } from '../lib/errors.js';
import { getSetting } from '../lib/settings.js';
import {
  extractWebVtt,
  ImageSubtitleError,
  listSubtitles,
  SubtitleConversionError,
  SubtitleNotFoundError,
  type EmbeddedSubtitleStream,
  type SubtitleMediaFile,
} from '../streaming/subtitles.js';
import { verifyStreamToken } from '../streaming/stream-tokens.js';

// Subtitle endpoints, registered on the /api/stream prefix alongside the
// direct-play/HLS routes. They follow the identical auth chain: a signed
// streaming token scoped to exactly this media file, the token's user loaded
// fresh (deleted => 401, disabled => 403), and library access re-checked at
// use time via assertMediaItemAccess with the 404 enumeration cloak.
//
//   GET /api/stream/subtitles/:mediaFileId?token=...           -> JSON track list
//   GET /api/stream/subtitles/:mediaFileId/:trackId.vtt?token= -> a WebVTT body

export interface SubtitleRoutesOptions {
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

/** `<trackId>.vtt` filename → trackId. Rejects anything with a path separator. */
const VTT_FILE_PATTERN = /^([A-Za-z0-9_-]+)\.vtt$/;

interface MediaFileRow {
  id: string;
  mediaItemId: string;
  path: string;
  streams: {
    streamIndex: number;
    codec: string | null;
    language: string | null;
    title: string | null;
    isForced: boolean;
    isDefault: boolean;
  }[];
}

function toSubtitleMediaFile(file: MediaFileRow): SubtitleMediaFile {
  const subtitleStreams: EmbeddedSubtitleStream[] = file.streams.map((stream) => ({
    streamIndex: stream.streamIndex,
    codec: stream.codec,
    language: stream.language,
    title: stream.title,
    forced: stream.isForced,
    default: stream.isDefault,
  }));
  return { id: file.id, path: file.path, subtitleStreams };
}

export const subtitleRoutes: FastifyPluginAsync<SubtitleRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();

  /**
   * Verifies the token, requires it to be scoped to `mediaFileId`, loads the
   * user fresh (deleted => 401, disabled => 403), then loads the media file
   * with its subtitle streams and re-checks library access at use time. The
   * missing-file 404 is byte-identical to the ungranted-library 404 (cloak).
   */
  const authenticateAndLoad = async (
    request: FastifyRequest,
    mediaFileId: string,
  ): Promise<{ user: AuthUser; file: MediaFileRow }> => {
    const token = extractStreamToken(request.query);
    if (token === undefined) throw tokenInvalidError();
    const verification = verifyStreamToken(token, opts.streamTokenSecret);
    if (!verification.ok) throw tokenInvalidError();
    if (verification.claims.mediaFileId !== mediaFileId) throw tokenInvalidError();

    const userRow = await prisma.user.findUnique({ where: { id: verification.claims.userId } });
    if (userRow === null) throw tokenInvalidError();
    if (!userRow.isEnabled) {
      throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    }
    const user = toAuthUser(userRow);

    const file = await prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: {
        id: true,
        mediaItemId: true,
        path: true,
        streams: {
          where: { type: 'subtitle' },
          select: {
            streamIndex: true,
            codec: true,
            language: true,
            title: true,
            isForced: true,
            isDefault: true,
          },
        },
      },
    });
    if (file === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    await assertMediaItemAccess(user, file.mediaItemId);

    return { user, file };
  };

  /** Lists the available subtitle tracks (text + image) for a media file. */
  app.get('/subtitles/:mediaFileId', async (request, reply) => {
    const { mediaFileId } = request.params as { mediaFileId: string };
    const { file } = await authenticateAndLoad(request, mediaFileId);

    const tracks = await listSubtitles(toSubtitleMediaFile(file), {
      mediaRoots: opts.config.MEDIA_ROOTS,
    });
    return reply.send({ mediaFileId, tracks });
  });

  /**
   * Serves one track as WebVTT. Unknown/malformed track ids and an unresolvable
   * source cloak to 404; an image-based track returns a typed 415 (it cannot be
   * turned into text — burn-in is a future item); a conversion failure is 422.
   */
  app.get('/subtitles/:mediaFileId/:file', async (request, reply) => {
    const { mediaFileId, file: fileName } = request.params as {
      mediaFileId: string;
      file: string;
    };

    // Reject a bad filename before any auth/db work; it can never be a track.
    const match = VTT_FILE_PATTERN.exec(fileName);
    if (match === null) throw notFoundError('Not found');
    const trackId = match[1] as string;

    const { file } = await authenticateAndLoad(request, mediaFileId);
    const transcodeDir = await getSetting('transcodeDir', app.log);

    let vtt: string;
    try {
      vtt = await extractWebVtt(toSubtitleMediaFile(file), trackId, {
        mediaRoots: opts.config.MEDIA_ROOTS,
        transcodeDir,
      });
    } catch (err) {
      if (err instanceof SubtitleNotFoundError) throw notFoundError('Not found');
      if (err instanceof ImageSubtitleError) {
        throw new ApiError(
          415,
          'IMAGE_SUBTITLE',
          'This subtitle track is image-based and cannot be served as WebVTT',
        );
      }
      if (err instanceof SubtitleConversionError) {
        request.log.debug({ err, mediaFileId, trackId }, 'subtitle conversion failed');
        throw new ApiError(
          422,
          'SUBTITLE_CONVERSION_FAILED',
          'This subtitle track could not be converted to WebVTT',
        );
      }
      throw err;
    }

    void reply.header('content-type', 'text/vtt; charset=utf-8');
    void reply.header('cache-control', 'private, max-age=0');
    return reply.send(vtt);
  });
};
