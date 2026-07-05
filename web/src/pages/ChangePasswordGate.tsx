import { AuthLayout } from '../components/AuthLayout';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { useAuth } from '../auth/context';

/**
 * Forced password change. Rendered in place of the whole app whenever the
 * current user has mustChangePassword set; clearing it (on success) reopens
 * the app because the auth flag flips.
 */
export function ChangePasswordGate() {
  const { logout } = useAuth();

  return (
    <AuthLayout
      title="Set a new password"
      subtitle="Your administrator requires you to choose a new password before continuing."
      footer={
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void logout()}
          style={{ marginTop: 'var(--space-2)' }}
        >
          Log out instead
        </button>
      }
    >
      <ChangePasswordForm submitLabel="Save and continue" />
    </AuthLayout>
  );
}
