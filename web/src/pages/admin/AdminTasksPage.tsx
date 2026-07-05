import { useState } from 'react';

import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { useRunTask, useTasks, type TaskStatus } from '../../api/admin';
import { errorMessage, formatDateTime, formatDuration, formatInterval } from './adminHelpers';
import styles from './Admin.module.css';

function summariseResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  try {
    return JSON.stringify(result);
  } catch {
    return '';
  }
}

function StatusBadge({ task }: { task: TaskStatus }) {
  if (task.state === 'running') {
    return <span className={`${styles.badge} ${styles.badgeWarn}`}>running</span>;
  }
  if (!task.enabled) {
    return <span className={`${styles.badge} ${styles.badgeNeutral}`}>disabled</span>;
  }
  if (task.lastError !== null) {
    return <span className={`${styles.badge} ${styles.badgeDanger}`}>failed</span>;
  }
  if (task.lastRunAt !== null) {
    return <span className={`${styles.badge} ${styles.badgeSuccess}`}>idle</span>;
  }
  return <span className={`${styles.badge} ${styles.badgeNeutral}`}>never run</span>;
}

export function AdminTasksPage() {
  const tasks = useTasks();
  const runTask = useRunTask();
  const [banner, setBanner] = useState<string | null>(null);

  const run = (id: string) => {
    setBanner(null);
    runTask.mutate(id, { onError: (error) => setBanner(errorMessage(error)) });
  };

  if (tasks.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading tasks" />
      </div>
    );
  }

  if (tasks.isError) {
    return (
      <ErrorState
        title="Couldn't load tasks"
        message={errorMessage(tasks.error)}
        onRetry={() => void tasks.refetch()}
      />
    );
  }

  return (
    <section className={styles.section} aria-labelledby="tasks-heading">
      <div className={styles.toolbar}>
        <h2 id="tasks-heading" className={styles.toolbarTitle}>
          Scheduled tasks
        </h2>
      </div>

      {banner !== null && (
        <p className="alert alert-error" role="alert">
          {banner}
        </p>
      )}

      {tasks.data.length === 0 ? (
        <div className={styles.stateBlock}>No scheduled tasks are registered on this server.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Scheduled tasks</caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Last run</th>
                <th scope="col">Duration</th>
                <th scope="col">Result</th>
                <th scope="col">Schedule</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((task) => {
                const running =
                  task.state === 'running' ||
                  (runTask.isPending && runTask.variables === task.id);
                return (
                  <tr key={task.id}>
                    <td className={styles.primaryCell}>{task.name}</td>
                    <td>
                      <StatusBadge task={task} />
                    </td>
                    <td className={styles.muted}>{formatDateTime(task.lastRunAt)}</td>
                    <td className={styles.muted}>{formatDuration(task.lastDurationMs)}</td>
                    <td className={styles.muted}>
                      {task.lastError !== null ? (
                        <span className={styles.badgeDanger}>{task.lastError}</span>
                      ) : (
                        summariseResult(task.lastResult) || '—'
                      )}
                    </td>
                    <td className={styles.muted}>
                      {task.enabled ? formatInterval(task.intervalMs) : 'not scheduled'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`btn btn-ghost ${styles.btnSm}`}
                        disabled={running}
                        onClick={() => run(task.id)}
                      >
                        {running ? 'Running…' : 'Run now'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
