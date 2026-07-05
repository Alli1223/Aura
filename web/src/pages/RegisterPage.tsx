import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import { usePublicSettings } from '../api/queries';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../auth/context';

const MIN_PASSWORD_LENGTH = 10;

export function RegisterPage() {
  const { register } = useAuth();
  const settings = usePublicSettings();
  const usernameId = useId();
  const emailId = useId();
  const passwordId = useId();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      await register({
        username,
        password,
        email: email.trim() === '' ? undefined : email.trim(),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create your account. Try again.');
      setSubmitting(false);
    }
  };

  // Registration closed: only render once settings have loaded so we don't
  // flash the wrong state. Default to closed until we know.
  if (settings.isSuccess && !settings.data.registrationEnabled) {
    return (
      <AuthLayout
        title="Registration closed"
        subtitle="New sign-ups are currently disabled on this server."
        footer={
          <span>
            Already have an account? <Link to="/login">Sign in</Link>
          </span>
        }
      >
        <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>
          Ask an administrator to enable registration or grant you an account.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create account"
      subtitle="Set up your Aura account to get started."
      footer={
        <span>
          Already have an account? <Link to="/login">Sign in</Link>
        </span>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label className="field-label" htmlFor={usernameId}>
            Username
          </label>
          <input
            id={usernameId}
            className="input"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>

        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label className="field-label" htmlFor={emailId}>
            Email <span style={{ color: 'var(--color-text-faint)' }}>(optional)</span>
          </label>
          <input
            id={emailId}
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label className="field-label" htmlFor={passwordId}>
            Password
          </label>
          <input
            id={passwordId}
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
        </div>

        {error && (
          <p className="alert alert-error" role="alert" style={{ marginTop: 'var(--space-4)' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={submitting}
          style={{ marginTop: 'var(--space-5)' }}
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
