import { useId, useState, type FormEvent } from 'react';

import { ApiError } from '../api/client';
import { useAuth } from '../auth/context';

const MIN_PASSWORD_LENGTH = 10;

export interface ChangePasswordFormProps {
  /** Called after the password change succeeds. */
  onSuccess?: () => void;
  submitLabel?: string;
}

/** Working change-password form: currentPassword + newPassword (+ confirm). */
export function ChangePasswordForm({
  onSuccess,
  submitLabel = 'Update password',
}: ChangePasswordFormProps) {
  const { changePassword } = useAuth();
  const currentId = useId();
  const newId = useId();
  const confirmId = useId();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onSuccess?.();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not update your password. Try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label className="field-label" htmlFor={currentId}>
          Current password
        </label>
        <input
          id={currentId}
          className="input"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </div>

      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <label className="field-label" htmlFor={newId}>
          New password
        </label>
        <input
          id={newId}
          className="input"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </div>

      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <label className="field-label" htmlFor={confirmId}>
          Confirm new password
        </label>
        <input
          id={confirmId}
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
        />
      </div>

      {error && (
        <p className="alert alert-error" role="alert" style={{ marginTop: 'var(--space-4)' }}>
          {error}
        </p>
      )}
      {success && (
        <p className="alert alert-success" role="status" style={{ marginTop: 'var(--space-4)' }}>
          Password updated.
        </p>
      )}

      <button
        type="submit"
        className="btn btn-primary btn-block"
        disabled={submitting}
        style={{ marginTop: 'var(--space-5)' }}
      >
        {submitting ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
