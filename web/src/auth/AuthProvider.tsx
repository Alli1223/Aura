import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  refreshSession,
  setAccessToken,
  setAuthBridge,
  type AuthBridge,
} from '../api/client';
import * as api from '../api/endpoints';
import type { AuthSession, AuthUser, PlaybackPreferencesInput } from '../api/types';
import { AuthContext, type AuthContextValue, type AuthStatus } from './context';

/**
 * Owns the current user + access token (in memory only) and restores the
 * session on boot via a silent refresh. The refresh cookie (httpOnly) is what
 * actually persists the session across reloads.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  const applySession = useCallback((session: AuthSession) => {
    setAccessToken(session.accessToken);
    setUser(session.user);
    setStatus('authenticated');
  }, []);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  // Bridge the framework-agnostic client back into React: a silent refresh
  // syncs the user; a failed refresh forces a logout. Registered before the
  // first request so a boot-time rotation is never missed.
  useEffect(() => {
    const bridge: AuthBridge = {
      onRefreshed: (session) => {
        setUser(session.user);
        setStatus('authenticated');
      },
      onCleared: clearSession,
    };
    setAuthBridge(bridge);
    return () => setAuthBridge(null);
  }, [clearSession]);

  const runBoot = useCallback(async () => {
    setStatus('loading');
    try {
      const session = await refreshSession();
      applySession(session);
    } catch (err) {
      // 401/403 simply means "no session" — that is the normal logged-out
      // state, not an error. Anything else (network, 5xx) is transient and
      // offered a retry.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearSession();
      } else {
        setStatus('error');
      }
    }
  }, [applySession, clearSession]);

  // Boot once on mount. A ref guards against React 18/19 StrictMode running
  // the effect twice in development.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void runBoot();
  }, [runBoot]);

  const login = useCallback(
    async (input: api.LoginInput) => {
      applySession(await api.login(input));
    },
    [applySession],
  );

  const register = useCallback(
    async (input: api.RegisterInput) => {
      applySession(await api.register(input));
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Even if the network call fails, drop local auth state.
    }
    clearSession();
  }, [clearSession]);

  const changePassword = useCallback(async (input: api.ChangePasswordInput) => {
    await api.changePassword(input);
    // The server cleared the flag; mirror it locally so the gate opens without
    // a full re-fetch. The current access token stays valid until it expires.
    setUser((current) => (current === null ? current : { ...current, mustChangePassword: false }));
  }, []);

  const updatePreferences = useCallback(async (input: PlaybackPreferencesInput) => {
    // The server returns the full updated user; sync it so consumers (e.g. the
    // player's default quality / subtitle / autoplay) see the new preferences.
    const updated = await api.updatePreferences(input);
    setUser(updated);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isAuthenticated: status === 'authenticated' && user !== null,
      isAdmin: user?.role === 'admin',
      mustChangePassword: user?.mustChangePassword ?? false,
      login,
      register,
      logout,
      changePassword,
      updatePreferences,
      retryBoot: () => void runBoot(),
    }),
    [status, user, login, register, logout, changePassword, updatePreferences, runBoot],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
