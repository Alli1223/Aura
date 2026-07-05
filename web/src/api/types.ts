/** Shared API DTOs mirroring the server response shapes. */

export type UserRole = 'admin' | 'user';

export type LibraryType = 'movies' | 'tv' | 'anime' | 'recordings' | 'other';

/** Safe user shape returned by the server (never includes credentials). */
export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  isEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Library {
  id: string;
  name: string;
  type: LibraryType;
  paths: string[];
  createdAt: string;
  updatedAt: string;
}

/** Unauthenticated settings the login/register pages need. */
export interface PublicSettings {
  serverName: string;
  registrationEnabled: boolean;
}

/** Successful auth response ({ user, accessToken }) from login/register/refresh. */
export interface AuthSession {
  user: AuthUser;
  accessToken: string;
}
