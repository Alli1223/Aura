import { Navigate, Outlet } from 'react-router';

import { useAuth } from '../auth/context';

/** Gate for admin-only routes. Non-admins are sent back to the home screen. */
export function RequireAdmin() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Outlet /> : <Navigate to="/" replace />;
}
