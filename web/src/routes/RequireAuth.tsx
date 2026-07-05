import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from '../auth/context';
import { ChangePasswordGate } from '../pages/ChangePasswordGate';

/**
 * Gate for private routes. Unauthenticated users are bounced to /login
 * (remembering where they were headed). A user flagged mustChangePassword is
 * held at a forced change-password screen until they clear it.
 */
export function RequireAuth() {
  const { isAuthenticated, mustChangePassword } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (mustChangePassword) {
    return <ChangePasswordGate />;
  }

  return <Outlet />;
}
