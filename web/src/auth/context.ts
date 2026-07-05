import { createContext, useContext } from 'react';

import type { LoginInput, RegisterInput, ChangePasswordInput } from '../api/endpoints';
import type { AuthUser } from '../api/types';

/**
 * Boot restores the session by refreshing:
 * - `loading`         — the boot refresh is in flight
 * - `authenticated`   — a valid session was restored / established
 * - `unauthenticated` — no session (expected; show login)
 * - `error`           — the boot refresh failed for a transient reason
 *                       (network / server error), so it is retryable
 */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  /** True while the current user is forced to change their password. */
  mustChangePassword: boolean;
  login(input: LoginInput): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): Promise<void>;
  changePassword(input: ChangePasswordInput): Promise<void>;
  /** Re-attempt the boot refresh after an `error` status. */
  retryBoot(): void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return value;
}
