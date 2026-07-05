import { useState } from 'react';

import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import { useAuth } from '../../auth/context';
import {
  QUALITY_NAMES,
  useDeleteUser,
  useSetUserPassword,
  useUpdateUser,
  useUsers,
  type AdminUser,
  type QualityName,
  type UpdateUserInput,
} from '../../api/admin';
import type { UserRole } from '../../api/types';
import { Dialog } from './Dialog';
import { errorMessage, formatDateTime, generateTempPassword } from './adminHelpers';
import styles from './Admin.module.css';

export function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const users = useUsers();
  const updateUser = useUpdateUser();
  const setPassword = useSetUserPassword();
  const deleteUser = useDeleteUser();

  const [banner, setBanner] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [confirmReset, setConfirmReset] = useState<AdminUser | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(
    null,
  );
  const [dialogError, setDialogError] = useState<string | null>(null);

  const patchUser = (user: AdminUser, input: UpdateUserInput) => {
    setBanner(null);
    updateUser.mutate(
      { id: user.id, input },
      { onError: (error) => setBanner(errorMessage(error)) },
    );
  };

  const doReset = () => {
    if (confirmReset === null) return;
    const target = confirmReset;
    const password = generateTempPassword();
    setDialogError(null);
    setPassword.mutate(
      { id: target.id, newPassword: password },
      {
        onSuccess: () => {
          setConfirmReset(null);
          setTempPassword({ username: target.username, password });
        },
        onError: (error) => setDialogError(errorMessage(error)),
      },
    );
  };

  const doDelete = () => {
    if (confirmDelete === null) return;
    setDialogError(null);
    deleteUser.mutate(confirmDelete.id, {
      onSuccess: () => setConfirmDelete(null),
      onError: (error) => setDialogError(errorMessage(error)),
    });
  };

  if (users.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading users" />
      </div>
    );
  }

  if (users.isError) {
    return (
      <ErrorState
        title="Couldn't load users"
        message={errorMessage(users.error)}
        onRetry={() => void users.refetch()}
      />
    );
  }

  const rowBusy = (id: string) => updateUser.isPending && updateUser.variables?.id === id;

  return (
    <section className={styles.section} aria-labelledby="users-heading">
      <div className={styles.toolbar}>
        <h2 id="users-heading" className={styles.toolbarTitle}>
          Users ({users.data.length})
        </h2>
      </div>

      {banner !== null && (
        <p className="alert alert-error" role="alert">
          {banner}
        </p>
      )}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="visually-hidden">User accounts</caption>
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Enabled</th>
              <th scope="col">Last login</th>
              <th scope="col">Max quality</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => {
              const isSelf = user.id === currentUser?.id;
              const busy = rowBusy(user.id);
              return (
                <tr key={user.id}>
                  <td className={styles.primaryCell}>
                    {user.username}
                    {isSelf && <span className={styles.muted}> (you)</span>}
                  </td>
                  <td className={styles.muted}>{user.email ?? '—'}</td>
                  <td>
                    <label className="visually-hidden" htmlFor={`role-${user.id}`}>
                      Role for {user.username}
                    </label>
                    <select
                      id={`role-${user.id}`}
                      className={styles.select}
                      value={user.role}
                      disabled={busy}
                      onChange={(event) =>
                        patchUser(user, { role: event.target.value as UserRole })
                      }
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>
                    <label className={styles.switch}>
                      <input
                        type="checkbox"
                        checked={user.isEnabled}
                        disabled={busy}
                        aria-label={`Enabled for ${user.username}`}
                        onChange={(event) => patchUser(user, { isEnabled: event.target.checked })}
                      />
                      <span className={styles.switchTrack} aria-hidden="true">
                        <span className={styles.switchThumb} />
                      </span>
                    </label>
                  </td>
                  <td className={styles.muted}>{formatDateTime(user.lastLoginAt)}</td>
                  <td>
                    <label className="visually-hidden" htmlFor={`quality-${user.id}`}>
                      Max quality for {user.username}
                    </label>
                    <select
                      id={`quality-${user.id}`}
                      className={styles.select}
                      value={user.maxQuality ?? ''}
                      disabled={busy}
                      onChange={(event) =>
                        patchUser(user, {
                          maxQuality: event.target.value === '' ? null : (event.target.value as QualityName),
                        })
                      }
                    >
                      <option value="">Server default</option>
                      {QUALITY_NAMES.map((quality) => (
                        <option key={quality} value={quality}>
                          {quality}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={`btn btn-ghost ${styles.btnSm}`}
                        onClick={() => {
                          setDialogError(null);
                          setConfirmReset(user);
                        }}
                      >
                        Reset password
                      </button>
                      <button
                        type="button"
                        className={`btn btn-ghost ${styles.btnSm} ${styles.btnDanger}`}
                        disabled={isSelf}
                        title={isSelf ? 'You cannot delete your own account' : undefined}
                        onClick={() => {
                          setDialogError(null);
                          setConfirmDelete(user);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirmReset !== null && (
        <Dialog
          title="Reset password"
          onClose={() => setConfirmReset(null)}
          actions={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmReset(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={setPassword.isPending}
                onClick={doReset}
              >
                {setPassword.isPending ? 'Resetting…' : 'Generate temporary password'}
              </button>
            </>
          }
        >
          <p>
            Generate a temporary password for <strong>{confirmReset.username}</strong>. They will be
            required to set a new password the next time they sign in, and every active session is
            revoked.
          </p>
          {dialogError !== null && (
            <p className="alert alert-error" role="alert">
              {dialogError}
            </p>
          )}
        </Dialog>
      )}

      {tempPassword !== null && (
        <Dialog
          title="Temporary password"
          onClose={() => setTempPassword(null)}
          actions={
            <button type="button" className="btn btn-primary" onClick={() => setTempPassword(null)}>
              Done
            </button>
          }
        >
          <p>
            Share this one-time password with <strong>{tempPassword.username}</strong>. It won&apos;t
            be shown again.
          </p>
          <code className={styles.secretValue}>{tempPassword.password}</code>
        </Dialog>
      )}

      {confirmDelete !== null && (
        <Dialog
          title="Delete user"
          onClose={() => setConfirmDelete(null)}
          actions={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`btn btn-primary ${styles.btnDanger}`}
                disabled={deleteUser.isPending}
                onClick={doDelete}
              >
                {deleteUser.isPending ? 'Deleting…' : 'Delete user'}
              </button>
            </>
          }
        >
          <p>
            Permanently delete <strong>{confirmDelete.username}</strong>? This removes their access
            grants and watch history and cannot be undone.
          </p>
          {dialogError !== null && (
            <p className="alert alert-error" role="alert">
              {dialogError}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}
