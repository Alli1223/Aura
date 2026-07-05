import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { ApiError } from '../api/client';
import { usePublicSettings } from '../api/queries';
import { AuthLayout } from '../components/AuthLayout';
import { useAuth } from '../auth/context';

export function LoginPage() {
  const { login } = useAuth();
  const settings = usePublicSettings();
  const usernameId = useId();
  const passwordId = useId();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ username, password });
      // On success the auth state flips and PublicOnly redirects home.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Try again.');
      setSubmitting(false);
    }
  };

  const registrationEnabled = settings.data?.registrationEnabled ?? false;

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Enter your details to continue."
      footer={
        registrationEnabled ? (
          <span>
            Don&apos;t have an account? <Link to="/register">Create one</Link>
          </span>
        ) : null
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
          <label className="field-label" htmlFor={passwordId}>
            Password
          </label>
          <input
            id={passwordId}
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
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
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthLayout>
  );
}
