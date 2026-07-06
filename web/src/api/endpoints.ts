import { apiRequest } from './client';
import type {
  AuthSession,
  AuthUser,
  Library,
  PlaybackPreferencesInput,
  PublicSettings,
} from './types';

// ---- Auth -------------------------------------------------------------------

export interface LoginInput {
  username: string;
  password: string;
}

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
}

export function login(input: LoginInput): Promise<AuthSession> {
  return apiRequest<AuthSession>('/auth/login', {
    method: 'POST',
    body: input,
    skipAuthRefresh: true,
  });
}

export function register(input: RegisterInput): Promise<AuthSession> {
  return apiRequest<AuthSession>('/auth/register', {
    method: 'POST',
    body: input,
    skipAuthRefresh: true,
  });
}

export function logout(): Promise<void> {
  return apiRequest<void>('/auth/logout', { method: 'POST', skipAuthRefresh: true });
}

// ---- Settings ---------------------------------------------------------------

export function getPublicSettings(): Promise<PublicSettings> {
  return apiRequest<PublicSettings>('/settings/public', { skipAuthRefresh: true });
}

// ---- Libraries --------------------------------------------------------------

export async function getLibraries(): Promise<Library[]> {
  const data = await apiRequest<{ libraries: Library[] }>('/libraries');
  return data.libraries;
}

// ---- Current user -----------------------------------------------------------

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export function changePassword(input: ChangePasswordInput): Promise<void> {
  return apiRequest<void>('/users/me/password', { method: 'POST', body: input });
}

export async function getMe(): Promise<AuthUser> {
  const data = await apiRequest<{ user: AuthUser }>('/users/me');
  return data.user;
}

/**
 * Updates the current user's playback preferences (PATCH /users/me). Only the
 * fields present are changed; `null` clears a preference. Returns the updated
 * safe user shape so the caller can sync the auth context.
 */
export async function updatePreferences(input: PlaybackPreferencesInput): Promise<AuthUser> {
  const data = await apiRequest<{ user: AuthUser }>('/users/me', {
    method: 'PATCH',
    body: input,
  });
  return data.user;
}
