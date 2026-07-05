import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { assertMediaItemAccess, ITEM_NOT_FOUND_MESSAGE } from '../auth/access.js';
import { toAuthUser, type AuthUser } from '../auth/types.js';
import type { Config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { ApiError, notFoundError, sendError } from '../lib/errors.js';
import { isPathWithin, resolveMediaFileForServing } from '../lib/media-roots.js';
import { getSetting } from '../lib/settings.js';
import { parseBody } from '../lib/validation.js';
import {
  computeEtag,
  contentDispositionInline,
  contentTypeForPath,
  etagMatches,
  resolveRequestRange,
} from '../streaming/direct-play.js';
import { listAudioTracks, resolveAudioTrackIndex } from '../streaming/audio-tracks.js';
import {
  HLS_PLAYLIST_NAME,
  HlsInputError,
  HlsSessionManager,
  TooManySessionsError,
} from '../streaming/hls-session.js';
import { clientCapabilitiesSchema, decidePlayback } from '../streaming/playback-decision.js';
import {
  clampQuality,
  effectiveMaxQuality,
  isHlsQualityName,
  type HlsQualityName,
} from '../streaming/quality-ladder.js';
import {
  type StreamTokenClaims,
  issueStreamToken,
  verifyStreamToken,
} from '../streaming/stream-tokens.js';

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
   * Playback decision: given a client's declared capabilities (request body,
   * all fields optional — omissions fall back to a conservative web-browser
   * profile), decides direct play vs transcode for a media file and returns
   * BOTH the decision AND ready-to-use, token-carrying URLs so the player needs
   * only this one call before starting playback.
   *
   * This is a pre-playback API call, so it is access-token authed (JWT) rather
   * than stream-token authed; it MINTS a stream token here (same issuance the
   * /token route uses) and embeds it in the returned direct/HLS URLs. The
   * missing-id 404 is byte-identical to the ungranted-library 404 (enumeration
   * cloak), exactly like the /token route.
   */
  app.post('/decide/:mediaFileId', { preHandler: app.authenticate }, async (request, reply) => {
    const { mediaFileId } = request.params as { mediaFileId: string };

    const capabilities = parseBody(clientCapabilitiesSchema, request.body ?? {}, reply);
    if (capabilities === undefined) return reply;

    const file = await prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: {
        id: true,
        mediaItemId: true,
        container: true,
        videoCodec: true,
        width: true,
        height: true,
        bitrate: true,
        streams: { select: { type: true, codec: true } },
      },
    });
    // Same enumeration cloak as /token: a missing id and an ungranted library
    // are byte-identical 404s.
    if (file === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    await assertMediaItemAccess(request.user, file.mediaItemId);

    // The user's effective quality cap: min(their personal cap, server cap).
    // Enforced server-side so a capped user is never handed a rung above it.
    const serverMaxQuality = await getSetting('maxQuality', request.log);
    const maxQuality = effectiveMaxQuality(request.user.maxQuality, serverMaxQuality);

    const decision = decidePlayback({
      file: {
        container: file.container,
        videoCodec: file.videoCodec,
        width: file.width,
        height: file.height,
        bitrate: file.bitrate,
      },
      streams: file.streams,
      client: capabilities,
      maxQuality,
    });

    // One freshly minted stream token, scoped to this user + file, embedded in
    // whichever URL the player will actually hit next.
    const { token: streamToken, expiresAt } = issueStreamToken({
      userId: request.user.id,
      mediaFileId: file.id,
      secret: opts.streamTokenSecret,
      ttlMs: opts.config.STREAM_TOKEN_TTL_MS,
    });
    const encodedToken = encodeURIComponent(streamToken);

    if (decision.action === 'direct') {
      return reply.send({
        action: 'direct',
        reasons: decision.reasons,
        streamToken,
        expiresAt: expiresAt.toISOString(),
        url: `/api/stream/direct/${file.id}?token=${encodedToken}`,
      });
    }

    return reply.send({
      action: 'transcode',
      reasons: decision.reasons,
      transcodeReason: decision.transcodeReason,
      transcodeReasons: decision.transcodeReasons,
      quality: decision.quality,
      streamToken,
      expiresAt: expiresAt.toISOString(),
      hlsStartUrl: `/api/stream/hls/${file.id}?token=${encodedToken}&quality=${decision.quality}`,
    });
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

  // -------------------------------------------------------------------------
  // HLS transcoding
  // -------------------------------------------------------------------------

  // One session manager for the server lifetime. Killed on server shutdown so
  // no ffmpeg process or scratch dir leaks.
  const hls = new HlsSessionManager({
    mediaRoots: opts.config.MEDIA_ROOTS,
    getTranscodeDir: () => getSetting('transcodeDir', app.log),
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
    idleMs: opts.config.HLS_SESSION_IDLE_MS,
    maxSessions: opts.config.HLS_MAX_SESSIONS,
    logger: app.log,
  });
  app.addHook('onClose', async () => {
    await hls.shutdown();
  });

  /**
   * Shared front half of the HLS auth chain, identical in spirit to direct
   * play: verify the token signature/expiry, then load the token's user fresh
   * (deleted => 401, disabled => 403). Library access is re-checked per route
   * at use time (statelessness contract in streaming/stream-tokens.ts).
   */
  const authenticateStreamToken = async (
    request: FastifyRequest,
  ): Promise<{ claims: StreamTokenClaims; user: AuthUser; token: string }> => {
    const token = extractStreamToken(request.query);
    if (token === undefined) throw tokenInvalidError();
    const verification = verifyStreamToken(token, opts.streamTokenSecret);
    if (!verification.ok) throw tokenInvalidError();

    const userRow = await prisma.user.findUnique({ where: { id: verification.claims.userId } });
    if (userRow === null) throw tokenInvalidError();
    if (!userRow.isEnabled) throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    return { claims: verification.claims, user: toAuthUser(userRow), token };
  };

  /** Re-checks the media file exists and the user still has access (use-time). */
  const assertFileAccess = async (user: AuthUser, mediaFileId: string): Promise<void> => {
    const file = await prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { mediaItemId: true },
    });
    if (file === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    await assertMediaItemAccess(user, file.mediaItemId);
  };

  /**
   * Lists a media file's audio tracks for the player's mid-playback audio-track
   * menu. Token-authed exactly like direct play: verify the token, require it
   * scoped to this file, load the user fresh (deleted => 401, disabled => 403),
   * then re-check library access at use time (404 enumeration cloak, byte-
   * identical to a nonexistent id). Each track carries its AUDIO-RELATIVE index
   * (the value the player sends back as `audioTrack`), codec, channels,
   * language, default flag and a human-friendly label.
   */
  app.get('/audio/:mediaFileId', async (request, reply) => {
    const { mediaFileId } = request.params as { mediaFileId: string };
    const { claims, user } = await authenticateStreamToken(request);
    if (claims.mediaFileId !== mediaFileId) throw tokenInvalidError();

    const file = await prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: {
        id: true,
        mediaItemId: true,
        streams: {
          where: { type: 'audio' },
          select: {
            streamIndex: true,
            codec: true,
            language: true,
            title: true,
            channels: true,
            isDefault: true,
          },
        },
      },
    });
    if (file === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    await assertMediaItemAccess(user, file.mediaItemId);

    const tracks = listAudioTracks(
      file.streams.map((stream) => ({
        streamIndex: stream.streamIndex,
        codec: stream.codec,
        language: stream.language,
        title: stream.title,
        channels: stream.channels,
        default: stream.isDefault,
      })),
    );
    return reply.send({ mediaFileId, tracks });
  });

  /** Only playlist and segment basenames — no path separators, no traversal. */
  const HLS_FILE_PATTERN = /^[a-zA-Z0-9_.-]+\.(m3u8|ts)$/;

  /**
   * The requested quality rung, or undefined when the client did not ask for
   * one (the server default then applies). An explicit but unknown value is a
   * 400 — the client asked for something that does not exist.
   */
  function parseRequestedQuality(query: unknown): HlsQualityName | undefined {
    const raw = (query as Record<string, unknown> | null)?.quality;
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !isHlsQualityName(raw)) {
      throw new ApiError(400, 'VALIDATION', 'Unsupported quality');
    }
    return raw;
  }

  /**
   * Optional audio-track selection for an HLS start, accepted on the query
   * string or the JSON body (query wins). `audioTrack` is an audio-relative
   * index (validated as a non-negative integer; out-of-range values fall back
   * to the default track later). `downmixStereo` declares a stereo-only client
   * ("true"/"false" or a real boolean). Unknown keys are ignored.
   */
  const audioSelectionSchema = z.object({
    audioTrack: z.coerce.number().int().nonnegative().optional(),
    downmixStereo: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((value) => (typeof value === 'boolean' ? value : value === 'true'))
      .optional(),
  });

  /** Parses audio selection from query/body; a malformed value is a 400. */
  function parseAudioSelection(request: FastifyRequest): {
    audioTrack: number | undefined;
    downmixStereo: boolean | undefined;
  } {
    const query = typeof request.query === 'object' && request.query !== null ? request.query : {};
    const body = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = audioSelectionSchema.safeParse({ ...body, ...query });
    if (!parsed.success) {
      throw new ApiError(400, 'VALIDATION', 'Invalid audio track selection');
    }
    return { audioTrack: parsed.data.audioTrack, downmixStereo: parsed.data.downmixStereo };
  }

  /**
   * Starts (or reuses) an HLS transcode session for a media file and returns
   * the playlist URL. Auth chain runs before any transcode work: token verify,
   * token-scoped-to-this-file, fresh user, file exists, library access.
   */
  app.post('/hls/:mediaFileId', async (request, reply) => {
    const { mediaFileId } = request.params as { mediaFileId: string };
    const { claims, user, token } = await authenticateStreamToken(request);
    if (claims.mediaFileId !== mediaFileId) throw tokenInvalidError();

    const requestedQuality = parseRequestedQuality(request.query);
    const { audioTrack: requestedAudioTrack, downmixStereo } = parseAudioSelection(request);
    // Resolve the requested rung (or the server default) and clamp it to the
    // user's effective cap — SERVER-SIDE, so a capped user who asks for a higher
    // rung is downgraded to the highest they are allowed. Never trust the client.
    const [defaultQuality, serverMaxQuality] = await Promise.all([
      getSetting('defaultQuality', request.log),
      getSetting('maxQuality', request.log),
    ]);
    const effectiveMax = effectiveMaxQuality(user.maxQuality, serverMaxQuality);
    const quality = clampQuality(requestedQuality ?? defaultQuality, effectiveMax);

    const file = await prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: {
        id: true,
        mediaItemId: true,
        path: true,
        streams: {
          where: { type: 'audio' },
          select: {
            streamIndex: true,
            codec: true,
            language: true,
            title: true,
            channels: true,
            isDefault: true,
          },
        },
      },
    });
    if (file === null) throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
    await assertMediaItemAccess(user, file.mediaItemId);

    // Resolve the requested audio-relative index against the file's actual audio
    // tracks: an in-range integer is honoured; omitted/out-of-range falls back to
    // the default (or first) track. The chosen track's channel count feeds the
    // surround-preservation decision when the client is not stereo-only.
    const audioTracks = listAudioTracks(
      file.streams.map((stream) => ({
        streamIndex: stream.streamIndex,
        codec: stream.codec,
        language: stream.language,
        title: stream.title,
        channels: stream.channels,
        default: stream.isDefault,
      })),
    );
    const audioTrackIndex = resolveAudioTrackIndex(audioTracks, requestedAudioTrack);
    const selectedAudioChannels = audioTracks[audioTrackIndex]?.channels;

    let session;
    try {
      session = await hls.startSession({
        mediaFile: { id: file.id, path: file.path },
        quality,
        userId: user.id,
        audioTrackIndex,
        downmixStereo,
        audioChannels: selectedAudioChannels,
      });
    } catch (err) {
      if (err instanceof HlsInputError) {
        if (err.reason === 'missing') {
          try {
            await prisma.mediaFile.update({ where: { id: file.id }, data: { status: 'missing' } });
          } catch (updateErr) {
            request.log.debug({ err: updateErr, mediaFileId: file.id }, 'could not mark missing');
          }
        }
        throw notFoundError(ITEM_NOT_FOUND_MESSAGE);
      }
      if (err instanceof TooManySessionsError) {
        // Sent directly (not thrown): the global handler collapses every 5xx to
        // a generic INTERNAL body, but this is an expected, retryable condition
        // the client should be told about explicitly.
        return sendError(
          reply,
          503,
          'TOO_MANY_SESSIONS',
          'The server is at its transcoding session limit; please try again shortly',
        );
      }
      request.log.error({ err, mediaFileId }, 'HLS transcode failed to start');
      throw new ApiError(500, 'TRANSCODE_FAILED', 'Failed to start transcoding this media');
    }

    const playlistUrl = `/api/stream/hls/${session.id}/${HLS_PLAYLIST_NAME}?token=${encodeURIComponent(token)}`;
    // Echo the granted quality so the UI reflects the actually-started rung
    // (which may be lower than requested when the user is capped), plus the
    // audio track that was actually selected (the resolved audio-relative index)
    // and whether the audio was downmixed to stereo.
    return reply.send({
      sessionId: session.id,
      playlistUrl,
      quality: session.quality,
      audioTrackIndex: session.audioTrackIndex,
      downmixStereo: session.downmixStereo,
    });
  });

  /**
   * Serves a session's playlist (.m3u8) or a segment (.ts). Token-authed; the
   * session must exist and belong to the token's user AND media file, and the
   * user's library access is re-checked at use time. The filename is validated
   * against a strict allowlist and its resolved path is asserted to stay inside
   * the session dir (defence in depth against traversal).
   */
  app.get('/hls/:sessionId/:file', async (request, reply) => {
    const { sessionId, file } = request.params as { sessionId: string; file: string };
    const { claims, user } = await authenticateStreamToken(request);

    // A bad filename never becomes a filesystem read — reject before any I/O.
    if (!HLS_FILE_PATTERN.test(file)) throw notFoundError('Not found');

    const session = hls.getSession(sessionId);
    if (
      session === undefined ||
      session.userId !== claims.userId ||
      session.mediaFileId !== claims.mediaFileId
    ) {
      // Uniform 404 for unknown / not-yours / wrong-file: reveals nothing.
      throw notFoundError('Not found');
    }

    await assertFileAccess(user, session.mediaFileId);

    const resolved = path.resolve(session.outputDir, file);
    if (!isPathWithin(resolved, path.resolve(session.outputDir))) {
      throw notFoundError('Not found');
    }

    let stats;
    try {
      stats = await stat(resolved);
    } catch {
      throw notFoundError('Not found');
    }
    if (!stats.isFile()) throw notFoundError('Not found');

    hls.touch(sessionId);

    const isPlaylist = file.endsWith('.m3u8');
    void reply.header('content-type', isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    // The playlist grows while transcoding, so it must never be cached; a
    // segment's bytes never change for the session's lifetime.
    void reply.header(
      'cache-control',
      isPlaylist ? 'no-store' : 'public, max-age=31536000, immutable',
    );
    void reply.header('content-length', stats.size);

    if (request.method === 'HEAD') return reply.send();

    const stream = createReadStream(resolved);
    stream.on('error', (err) => {
      request.log.debug({ err, sessionId }, 'hls file stream error');
    });
    return reply.send(stream);
  });

  /**
   * Stops a session (owner only). Idempotent: an unknown session, or a session
   * owned by someone else, still returns 204 and leaks nothing.
   */
  app.delete('/hls/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const { claims } = await authenticateStreamToken(request);

    const session = hls.getSession(sessionId);
    if (session !== undefined && session.userId === claims.userId) {
      await hls.stopSession(sessionId);
    }
    return reply.code(204).send();
  });
};
