import { z } from 'zod';

// SQLite has no enum column type, so enum-like columns in the Prisma schema
// are plain strings. These value unions + zod schemas are the single source
// of truth for the allowed values; validate at the application boundary
// before writing to the database.

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleSchema = z.enum(USER_ROLES);

export const LIBRARY_TYPES = ['movies', 'tv', 'anime', 'recordings', 'other'] as const;
export type LibraryType = (typeof LIBRARY_TYPES)[number];
export const libraryTypeSchema = z.enum(LIBRARY_TYPES);

export const MEDIA_ITEM_TYPES = ['movie', 'show', 'season', 'episode'] as const;
export type MediaItemType = (typeof MEDIA_ITEM_TYPES)[number];
export const mediaItemTypeSchema = z.enum(MEDIA_ITEM_TYPES);

export const MEDIA_FILE_STATUSES = ['available', 'missing'] as const;
export type MediaFileStatus = (typeof MEDIA_FILE_STATUSES)[number];
export const mediaFileStatusSchema = z.enum(MEDIA_FILE_STATUSES);

export const STREAM_TYPES = ['video', 'audio', 'subtitle'] as const;
export type StreamType = (typeof STREAM_TYPES)[number];
export const streamTypeSchema = z.enum(STREAM_TYPES);

// Personal API token scopes. "read" tokens may only make safe (GET/HEAD)
// requests; "full" tokens may make any request the owning user could, still
// bounded by the user's role (admin routes stay admin-only) and library grants.
export const API_TOKEN_SCOPES = ['read', 'full'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
export const apiTokenScopeSchema = z.enum(API_TOKEN_SCOPES);
