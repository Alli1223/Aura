import { useState } from 'react';

import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { useAccessMatrix, useToggleAccess } from '../../api/admin';
import { errorMessage } from './adminHelpers';
import styles from './Admin.module.css';

const cellKey = (userId: string, libraryId: string) => `${userId}:${libraryId}`;

export function AdminAccessPage() {
  const matrix = useAccessMatrix();
  const toggle = useToggleAccess();

  const [pending, setPending] = useState<Set<string>>(new Set());
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map());
  const [banner, setBanner] = useState<string | null>(null);

  const setPendingCell = (key: string, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const handleToggle = (userId: string, libraryId: string, grant: boolean) => {
    const key = cellKey(userId, libraryId);
    setBanner(null);
    setCellErrors((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    setPendingCell(key, true);
    toggle.mutate(
      { userId, libraryId, grant },
      {
        onError: (error) => {
          const message = errorMessage(error);
          setBanner(message);
          setCellErrors((current) => new Map(current).set(key, message));
        },
        onSettled: () => setPendingCell(key, false),
      },
    );
  };

  if (matrix.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading access matrix" />
      </div>
    );
  }

  if (matrix.isError) {
    return (
      <ErrorState
        title="Couldn't load access"
        message={errorMessage(matrix.error)}
        onRetry={() => void matrix.refetch()}
      />
    );
  }

  const { users, libraries } = matrix.data;

  return (
    <section className={styles.section} aria-labelledby="access-heading">
      <div className={styles.toolbar}>
        <h2 id="access-heading" className={styles.toolbarTitle}>
          Library access
        </h2>
      </div>
      <p className={styles.muted}>
        Tick a cell to grant a user access to a library; untick to revoke. Changes apply
        immediately. Admins can always see every library regardless of these grants.
      </p>

      {banner !== null && (
        <p className="alert alert-error" role="alert">
          {banner}
        </p>
      )}

      {users.length === 0 || libraries.length === 0 ? (
        <div className={styles.stateBlock}>
          {users.length === 0
            ? 'No users to manage yet.'
            : 'Create a library before assigning access.'}
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              Grant matrix of users (rows) against libraries (columns)
            </caption>
            <thead>
              <tr>
                <th scope="col" className={styles.matrixUserCell}>
                  User
                </th>
                {libraries.map((library) => (
                  <th key={library.id} scope="col" className={styles.matrixLibHead}>
                    {library.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <th scope="row" className={`${styles.matrixUserCell} ${styles.primaryCell}`}>
                    {user.username}{' '}
                    {user.role === 'admin' && (
                      <span className={`${styles.badge} ${styles.badgeAdmin}`}>admin</span>
                    )}
                    {!user.isEnabled && (
                      <span className={`${styles.badge} ${styles.badgeDanger}`}>disabled</span>
                    )}
                  </th>
                  {libraries.map((library) => {
                    const key = cellKey(user.id, library.id);
                    const checked = user.libraryIds.includes(library.id);
                    const isPending = pending.has(key);
                    const hasError = cellErrors.has(key);
                    return (
                      <td
                        key={library.id}
                        className={`${styles.matrixCell} ${hasError ? styles.cellError : ''}`}
                      >
                        <input
                          type="checkbox"
                          className={`${styles.matrixCheckbox} ${isPending ? styles.matrixPending : ''}`}
                          checked={checked}
                          disabled={isPending}
                          aria-label={`Grant ${user.username} access to ${library.name}`}
                          aria-invalid={hasError}
                          onChange={(event) =>
                            handleToggle(user.id, library.id, event.target.checked)
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
