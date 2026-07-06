import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { sendError } from '../lib/errors.js';
import { parseParams } from '../lib/validation.js';
import type { HlsSessionManager, HlsSessionSnapshot } from '../streaming/hls-session.js';

// Admin-only activity dashboard: a read-only view of the live transcode
// sessions the HLS manager is running (who is watching what, at which quality),
// plus a kill-session action. Both routes are admin-only — active-session
// detail (which users are streaming which files right now) is operator
// information, mirroring the scan/task admin surfaces.
//
// SCOPE NOTE (documented for the UI): the HLS session manager ONLY tracks
// *transcode* sessions. Direct-play streams (a file served byte-for-byte over
// the range endpoint) are stateless and hold no server-side session, so they do
// NOT appear here. Every row is therefore a transcode; the UI labels sessions
// accordingly.

export interface ActivityRoutesOptions {
  /**
   * The shared HLS transcode session manager (created in buildApp, also handed
   * to the stream plugin). This plugin only READS its snapshot and stops
   * sessions by id — it never starts one or touches ffmpeg directly.
   */
  hls: HlsSessionManager;
}

const sessionIdParamsSchema = z.object({ id: z.string().min(1, 'Session id is required') });

/** One enriched active session as returned by GET /api/activity/sessions. */
interface ActivitySessionResponse {
  id: string;
  userId: string;
  /** The streaming user's username, or null if the user row is gone. */
  username: string | null;
  mediaFileId: string;
  /** The media item the file belongs to, or null if the file row is gone. */
  mediaItemId: string | null;
  /** Display title of the media item, or null when unknown. */
  title: string | null;
  /** Media item type (movie/episode/…), or null when unknown. */
  itemType: string | null;
  quality: string;
  audioTrackIndex: number;
  downmixStereo: boolean;
  startOffsetSec: number;
  burnSubtitleTrackId: string | null;
  /**
   * Always true: the HLS manager only ever holds transcode sessions (direct
   * plays are untracked). Emitted explicitly so the client renders the
   * transcode-vs-direct label from data rather than assuming it.
   */
  transcode: boolean;
  /** Whether a subtitle is being burned into this transcode. */
  burningSubtitle: boolean;
  createdAt: string;
  lastAccess: string;
  state: HlsSessionSnapshot['state'];
}

export const activityRoutes: FastifyPluginAsync<ActivityRoutesOptions> = async (app, opts) => {
  const prisma = getPrisma();
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // Session ids the admin has explicitly killed via this plugin. Lets a repeat
  // DELETE of an already-stopped session stay idempotent (204) while a genuinely
  // unknown id is a 404. Bounded in practice to the count of admin kill actions
  // over the process lifetime (a tiny, human-driven number).
  const killedSessionIds = new Set<string>();

  /**
   * Lists every live transcode session, enriched with the streaming user's
   * username and the media item's title/type for display. The join is a single
   * batched lookup per entity type (users, files) keyed by the ids present in
   * the snapshot, so it stays cheap regardless of session count. A missing user
   * or file row (deleted mid-session) degrades to null fields rather than
   * dropping the row, so the admin still sees an active session to act on.
   */
  app.get('/sessions', adminOnly, async () => {
    const snapshots = opts.hls.listSessions();
    if (snapshots.length === 0) return { sessions: [] };

    const userIds = [...new Set(snapshots.map((s) => s.userId))];
    const fileIds = [...new Set(snapshots.map((s) => s.mediaFileId))];

    const [users, files] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true },
      }),
      prisma.mediaFile.findMany({
        where: { id: { in: fileIds } },
        select: { id: true, mediaItemId: true, mediaItem: { select: { title: true, type: true } } },
      }),
    ]);

    const usernameById = new Map(users.map((user) => [user.id, user.username]));
    const fileById = new Map(files.map((file) => [file.id, file]));

    const sessions: ActivitySessionResponse[] = snapshots.map((snapshot) => {
      const file = fileById.get(snapshot.mediaFileId);
      return {
        id: snapshot.id,
        userId: snapshot.userId,
        username: usernameById.get(snapshot.userId) ?? null,
        mediaFileId: snapshot.mediaFileId,
        mediaItemId: file?.mediaItemId ?? null,
        title: file?.mediaItem.title ?? null,
        itemType: file?.mediaItem.type ?? null,
        quality: snapshot.quality,
        audioTrackIndex: snapshot.audioTrackIndex,
        downmixStereo: snapshot.downmixStereo,
        startOffsetSec: snapshot.startOffsetSec,
        burnSubtitleTrackId: snapshot.burnSubtitleTrackId ?? null,
        transcode: true,
        burningSubtitle: snapshot.burnSubtitleTrackId !== undefined,
        createdAt: new Date(snapshot.createdAt).toISOString(),
        lastAccess: new Date(snapshot.lastAccess).toISOString(),
        state: snapshot.state,
      };
    });

    return { sessions };
  });

  /**
   * Kills a live transcode session by id (admin override — e.g. reclaiming a
   * stuck slot). 204 when a live session was stopped OR the id was already
   * killed via this endpoint (idempotent); 404 for an id the manager has never
   * run. Stopping tears down ffmpeg and removes the scratch dir via the manager.
   */
  app.delete('/sessions/:id', adminOnly, async (request, reply) => {
    const params = parseParams(sessionIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const live = opts.hls.getSession(params.id) !== undefined;
    if (!live) {
      // Already killed here before => idempotent 204; otherwise genuinely
      // unknown => 404.
      if (killedSessionIds.has(params.id)) return reply.code(204).send();
      return sendError(reply, 404, 'NOT_FOUND', 'Unknown session');
    }

    await opts.hls.stopSession(params.id);
    killedSessionIds.add(params.id);

    await writeAuditLog(
      prisma,
      {
        action: 'activity.session_killed',
        userId: request.user.id,
        targetType: 'hls_session',
        targetId: params.id,
        ip: request.ip,
      },
      request.log,
    );

    return reply.code(204).send();
  });
};
