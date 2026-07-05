import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from '../auth/context';

interface FromState {
  from?: { pathname?: string };
}

/** Login/register routes: an already-authenticated user is sent home. */
export function PublicOnly() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (isAuthenticated) {
    const from = (location.state as FromState | null)?.from?.pathname;
    return <Navigate to={from ?? '/'} replace />;
  }

  return <Outlet />;
}
