import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { apiRequest } from './client';

// Data layer for the admin activity dashboard: the live transcode sessions the
// server's HLS manager is running, plus a kill-session action. Mirrors the
// server contract in routes/activity.ts.
//
// NOTE: the HLS manager only tracks *transcode* sessions — direct plays are
// stateless and never appear here, so `transcode` is always true. The UI labels
// sessions accordingly.

// ---- DTOs -------------------------------------------------------------------

/** One live transcode session (server ActivitySessionResponse). */
export interface ActivitySession {
  id: string;
  userId: string;
  /** Streaming user's username, or null if the user row is gone. */
  username: string | null;
  mediaFileId: string;
  mediaItemId: string | null;
  /** Media item title, or null when unknown. */
  title: string | null;
  /** Media item type (movie/episode/…), or null when unknown. */
  itemType: string | null;
  quality: string;
  audioTrackIndex: number;
  downmixStereo: boolean;
  startOffsetSec: number;
  burnSubtitleTrackId: string | null;
  /** Always true — the manager only holds transcode sessions. */
  transcode: boolean;
  /** Whether a subtitle is being burned into this transcode. */
  burningSubtitle: boolean;
  createdAt: string;
  lastAccess: string;
  state: string;
}

// ---- Query keys -------------------------------------------------------------

export const activityKeys = {
  sessions: ['admin', 'activity', 'sessions'] as const,
};

/** How often the Activity section re-polls the live session list (ms). */
export const ACTIVITY_POLL_MS = 5000;

// ---- Requests ---------------------------------------------------------------

export async function getActivitySessions(): Promise<ActivitySession[]> {
  const data = await apiRequest<{ sessions: ActivitySession[] }>('/activity/sessions');
  return data.sessions;
}

export function killSession(id: string): Promise<void> {
  return apiRequest<void>(`/activity/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- Hooks ------------------------------------------------------------------

/**
 * The live transcode sessions, re-polled every ACTIVITY_POLL_MS while the
 * section is mounted so the list stays current without a manual refresh.
 */
export function useActivitySessions(): UseQueryResult<ActivitySession[]> {
  return useQuery({
    queryKey: activityKeys.sessions,
    queryFn: getActivitySessions,
    refetchInterval: ACTIVITY_POLL_MS,
  });
}

/**
 * Kills a session, optimistically removing its row from the cached list so the
 * table updates immediately; reconciles against the server on settle and
 * reverts on error.
 */
export function useKillSession(): UseMutationResult<
  void,
  Error,
  string,
  { previous: ActivitySession[] | undefined }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => killSession(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: activityKeys.sessions });
      const previous = queryClient.getQueryData<ActivitySession[]>(activityKeys.sessions);
      if (previous !== undefined) {
        queryClient.setQueryData<ActivitySession[]>(
          activityKeys.sessions,
          previous.filter((session) => session.id !== id),
        );
      }
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(activityKeys.sessions, context.previous);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: activityKeys.sessions }),
  });
}
