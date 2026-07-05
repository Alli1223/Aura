import { apiRequest } from './client';
import type { AuthSession, AuthUser, Library, PublicSettings } from './types';

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
