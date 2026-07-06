import { useState } from 'react';

import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { useActivitySessions, useKillSession, type ActivitySession } from '../../api/activity';
import { errorMessage, formatDateTime } from './adminHelpers';
import { Dialog } from './Dialog';
import styles from './Admin.module.css';

/** Human label for who is streaming (falls back to the raw id when unknown). */
function whoLabel(session: ActivitySession): string {
  return session.username ?? `user ${session.userId}`;
}

/** Human label for what is playing (title + type), or a fallback. */
function whatLabel(session: ActivitySession): string {
  return session.title ?? `file ${session.mediaFileId}`;
}

/** A short transcode descriptor: quality plus any burn-in note. */
function transcodeLabel(session: ActivitySession): string {
  const parts = [session.quality];
  if (session.downmixStereo) parts.push('stereo');
  if (session.burningSubtitle) parts.push('subtitle burn-in');
  return parts.join(' · ');
}

function StateBadge({ state }: { state: string }) {
  if (state === 'starting') {
    return <span className={`${styles.badge} ${styles.badgeWarn}`}>starting</span>;
  }
  return <span className={`${styles.badge} ${styles.badgeSuccess}`}>playing</span>;
}

/**
 * Admin Activity section: a live, auto-refreshing table of active transcode
 * sessions (who / what / quality / started / last active) with a per-row Stop
 * action guarded by a confirm dialog. Direct plays are stateless and untracked
 * server-side, so only transcode sessions appear here (noted in the caption).
 */
export function ActivitySection() {
  const sessions = useActivitySessions();
  const killSession = useKillSession();
  const [confirmStop, setConfirmStop] = useState<ActivitySession | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const doStop = () => {
    if (confirmStop === null) return;
    const target = confirmStop;
    setBanner(null);
    killSession.mutate(target.id, {
      onSuccess: () => setConfirmStop(null),
      onError: (error) => {
        setBanner(errorMessage(error));
        setConfirmStop(null);
      },
    });
  };

  if (sessions.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading activity" />
      </div>
    );
  }

  if (sessions.isError) {
    return (
      <ErrorState
        title="Couldn't load activity"
        message={errorMessage(sessions.error)}
        onRetry={() => void sessions.refetch()}
      />
    );
  }

  return (
    <section className={styles.section} aria-labelledby="activity-heading">
      <div className={styles.toolbar}>
        <h2 id="activity-heading" className={styles.toolbarTitle}>
          Active sessions
        </h2>
      </div>

      {banner !== null && (
        <p className="alert alert-error" role="alert">
          {banner}
        </p>
      )}

      {sessions.data.length === 0 ? (
        <div className={styles.stateBlock}>No active sessions.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              Active transcode sessions. Direct plays are not tracked.
            </caption>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Playing</th>
                <th scope="col">Transcode</th>
                <th scope="col">Started</th>
                <th scope="col">Last active</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((session) => {
                const stopping = killSession.isPending && killSession.variables === session.id;
                return (
                  <tr key={session.id}>
                    <td className={styles.primaryCell}>{whoLabel(session)}</td>
                    <td>
                      {whatLabel(session)}
                      {session.itemType !== null && (
                        <span className={styles.muted}> · {session.itemType}</span>
                      )}
                    </td>
                    <td>
                      <StateBadge state={session.state} />
                      <span className={styles.muted}> {transcodeLabel(session)}</span>
                    </td>
                    <td className={styles.muted}>{formatDateTime(session.createdAt)}</td>
                    <td className={styles.muted}>{formatDateTime(session.lastAccess)}</td>
                    <td>
                      <button
                        type="button"
                        className={`btn btn-ghost ${styles.btnSm} ${styles.btnDanger}`}
                        disabled={stopping}
                        onClick={() => {
                          setBanner(null);
                          setConfirmStop(session);
                        }}
                      >
                        {stopping ? 'Stopping…' : 'Stop'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmStop !== null && (
        <Dialog
          title="Stop session"
          onClose={() => setConfirmStop(null)}
          actions={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmStop(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn btn-primary ${styles.btnDanger}`}
                disabled={killSession.isPending}
                onClick={doStop}
              >
                {killSession.isPending ? 'Stopping…' : 'Stop session'}
              </button>
            </>
          }
        >
          <p>
            Stop the transcode session for <strong>{whoLabel(confirmStop)}</strong> playing{' '}
            <strong>{whatLabel(confirmStop)}</strong>? Their playback will be interrupted.
          </p>
        </Dialog>
      )}
    </section>
  );
}
