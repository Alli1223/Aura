import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { apiRequest } from './client';
import { queryKeys } from './queries';
import type { Library, LibraryType, UserRole } from './types';

// Data layer for the admin dashboard. Typed request builders + TanStack Query
// hooks over the server's admin contracts (users, libraries + scan, the
// user x library access matrix, settings and scheduled tasks). Every mutation
// invalidates the caches it can affect so the UI stays consistent; the access
// matrix and single-cell grants update optimistically for a snappy grid.

// ---- Quality ladder ---------------------------------------------------------
// Mirrors the server's HlsQualityName enum (streaming/quality-ladder.ts).

export const QUALITY_NAMES = ['1080p', '720p', '480p', '360p'] as const;
export type QualityName = (typeof QUALITY_NAMES)[number];

// ---- DTOs -------------------------------------------------------------------

/** Admin view of a user (== server toAuthUser, which includes maxQuality). */
export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  isEnabled: boolean;
  mustChangePassword: boolean;
  /** Per-user max transcode quality, or null for "no personal cap". */
  maxQuality: QualityName | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Fields an admin may PATCH on a user (each optional; server needs >= 1). */
export interface UpdateUserInput {
  role?: UserRole;
  isEnabled?: boolean;
  email?: string | null;
  maxQuality?: QualityName | null;
}

export interface CreateLibraryInput {
  name: string;
  type: LibraryType;
  paths: string[];
}

/** A library edit: name and/or paths (type is immutable server-side). */
export interface UpdateLibraryInput {
  name?: string;
  paths?: string[];
}

/** One file-level error captured during a scan. */
export interface ScanError {
  path: string;
  message: string;
}

/** Live/last counters of a library scan (server ScanStats). */
export interface ScanStats {
  filesSeen: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
  filesMissing: number;
  filesSkipped: number;
  itemsCreated: number;
  errors: ScanError[];
}

export type ScanStatus = 'idle' | 'scanning';

/** A library's scan state (server toScanResponse). */
export interface ScanState {
  libraryId: string;
  status: ScanStatus;
  startedAt: string | null;
  finishedAt: string | null;
  stats: ScanStats | null;
  error: string | null;
}

/** Result of the "scan all" trigger: per-library started/skipped. */
export interface ScanAllResult {
  libraryId: string;
  name: string;
  started: boolean;
}

/** A user row of the access matrix (safe fields + their granted library ids). */
export interface AccessUser {
  id: string;
  username: string;
  role: UserRole;
  isEnabled: boolean;
  libraryIds: string[];
}

/** A library column of the access matrix. */
export interface AccessLibrary {
  id: string;
  name: string;
  type: LibraryType;
}

/** GET /api/access — the full user x library grant matrix. */
export interface AccessMatrix {
  users: AccessUser[];
  libraries: AccessLibrary[];
}

/** Server settings (admin GET returns tmdbApiKey; the UI masks it). */
export interface AdminSettings {
  serverName: string;
  registrationEnabled: boolean;
  baseUrl: string;
  transcodeDir: string;
  defaultQuality: QualityName;
  maxQuality: QualityName;
  tmdbApiKey: string;
}

export type SettingsPatch = Partial<AdminSettings>;

export type TaskState = 'idle' | 'running';

/** Status of one scheduled task (server TaskStatus). */
export interface TaskStatus {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  state: TaskState;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastResult: unknown;
  lastError: string | null;
  nextRunAt: string | null;
  runCount: number;
}

// ---- Query keys -------------------------------------------------------------

export const adminKeys = {
  users: ['admin', 'users'] as const,
  libraries: ['admin', 'libraries'] as const,
  access: ['admin', 'access'] as const,
  settings: ['admin', 'settings'] as const,
  tasks: ['admin', 'tasks'] as const,
  scan: (libraryId: string) => ['admin', 'scan', libraryId] as const,
};

// ---- Requests ---------------------------------------------------------------

export async function getUsers(): Promise<AdminUser[]> {
  const data = await apiRequest<{ users: AdminUser[] }>('/users');
  return data.users;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<AdminUser> {
  const data = await apiRequest<{ user: AdminUser }>(`/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
  return data.user;
}

/** Admin sets a (temporary) password. The user must then change it on login. */
export function setUserPassword(id: string, newPassword: string): Promise<void> {
  return apiRequest<void>(`/users/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    body: { newPassword },
  });
}

export function deleteUser(id: string): Promise<void> {
  return apiRequest<void>(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getAdminLibraries(): Promise<Library[]> {
  const data = await apiRequest<{ libraries: Library[] }>('/libraries');
  return data.libraries;
}

export async function createLibrary(input: CreateLibraryInput): Promise<Library> {
  const data = await apiRequest<{ library: Library }>('/libraries', {
    method: 'POST',
    body: input,
  });
  return data.library;
}

export async function updateLibrary(id: string, input: UpdateLibraryInput): Promise<Library> {
  const data = await apiRequest<{ library: Library }>(`/libraries/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
  return data.library;
}

export function deleteLibrary(id: string): Promise<void> {
  return apiRequest<void>(`/libraries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function startLibraryScan(id: string): Promise<{ started: boolean }> {
  return apiRequest<{ started: boolean }>(`/libraries/${encodeURIComponent(id)}/scan`, {
    method: 'POST',
  });
}

export async function getLibraryScan(id: string): Promise<ScanState> {
  const data = await apiRequest<{ scan: ScanState }>(`/libraries/${encodeURIComponent(id)}/scan`);
  return data.scan;
}

export async function scanAll(): Promise<ScanAllResult[]> {
  const data = await apiRequest<{ libraries: ScanAllResult[] }>('/scan', { method: 'POST' });
  return data.libraries;
}

export function getAccessMatrix(): Promise<AccessMatrix> {
  return apiRequest<AccessMatrix>('/access');
}

export function grantAccess(libraryId: string, userId: string): Promise<void> {
  return apiRequest<void>(`/libraries/${encodeURIComponent(libraryId)}/access`, {
    method: 'POST',
    body: { userId },
  });
}

export function revokeAccess(libraryId: string, userId: string): Promise<void> {
  return apiRequest<void>(
    `/libraries/${encodeURIComponent(libraryId)}/access/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

export async function setUserLibraries(userId: string, libraryIds: string[]): Promise<string[]> {
  const data = await apiRequest<{ libraryIds: string[] }>(
    `/users/${encodeURIComponent(userId)}/libraries`,
    { method: 'PUT', body: { libraryIds } },
  );
  return data.libraryIds;
}

export async function getSettings(): Promise<AdminSettings> {
  const data = await apiRequest<{ settings: AdminSettings }>('/settings');
  return data.settings;
}

export async function updateSettings(patch: SettingsPatch): Promise<AdminSettings> {
  const data = await apiRequest<{ settings: AdminSettings }>('/settings', {
    method: 'PATCH',
    body: patch,
  });
  return data.settings;
}

export async function getTasks(): Promise<TaskStatus[]> {
  const data = await apiRequest<{ tasks: TaskStatus[] }>('/tasks');
  return data.tasks;
}

export function runTask(id: string): Promise<{ started: boolean; taskId: string }> {
  return apiRequest<{ started: boolean; taskId: string }>(
    `/tasks/${encodeURIComponent(id)}/run`,
    { method: 'POST' },
  );
}

// ---- Users hooks ------------------------------------------------------------

export function useUsers(): UseQueryResult<AdminUser[]> {
  return useQuery({ queryKey: adminKeys.users, queryFn: getUsers });
}

export function useUpdateUser(): UseMutationResult<
  AdminUser,
  Error,
  { id: string; input: UpdateUserInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => updateUser(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.users });
      // Role / enabled state also surface in the access matrix.
      void queryClient.invalidateQueries({ queryKey: adminKeys.access });
    },
  });
}

export function useSetUserPassword(): UseMutationResult<
  void,
  Error,
  { id: string; newPassword: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newPassword }) => setUserPassword(id, newPassword),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminKeys.users }),
  });
}

export function useDeleteUser(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteUser(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.users });
      void queryClient.invalidateQueries({ queryKey: adminKeys.access });
    },
  });
}

// ---- Libraries hooks --------------------------------------------------------

export function useAdminLibraries(): UseQueryResult<Library[]> {
  return useQuery({ queryKey: adminKeys.libraries, queryFn: getAdminLibraries });
}

/** Invalidates every view that a library mutation can affect. */
function invalidateLibraryViews(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: adminKeys.libraries });
  // The sidebar's permitted-libraries list.
  void queryClient.invalidateQueries({ queryKey: queryKeys.libraries });
  // Library columns of the access matrix.
  void queryClient.invalidateQueries({ queryKey: adminKeys.access });
}

export function useCreateLibrary(): UseMutationResult<Library, Error, CreateLibraryInput> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => createLibrary(input),
    onSuccess: () => invalidateLibraryViews(queryClient),
  });
}

export function useUpdateLibrary(): UseMutationResult<
  Library,
  Error,
  { id: string; input: UpdateLibraryInput }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) => updateLibrary(id, input),
    onSuccess: () => invalidateLibraryViews(queryClient),
  });
}

export function useDeleteLibrary(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteLibrary(id),
    onSuccess: () => invalidateLibraryViews(queryClient),
  });
}

/**
 * Live scan state for a library. Polls every 1.5s while a scan is running and
 * stops once idle. Only enabled once the caller marks the library as active
 * (a scan was just triggered), so we don't poll every library forever.
 */
export function useLibraryScan(
  libraryId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ScanState> {
  return useQuery({
    queryKey: adminKeys.scan(libraryId),
    queryFn: () => getLibraryScan(libraryId),
    enabled: options.enabled ?? true,
    refetchInterval: (query) => (query.state.data?.status === 'scanning' ? 1500 : false),
  });
}

export function useStartScan(): UseMutationResult<{ started: boolean }, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (libraryId) => startLibraryScan(libraryId),
    onSuccess: (_data, libraryId) =>
      void queryClient.invalidateQueries({ queryKey: adminKeys.scan(libraryId) }),
  });
}

export function useScanAll(): UseMutationResult<ScanAllResult[], Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => scanAll(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'scan'] }),
  });
}

// ---- Access matrix hooks ----------------------------------------------------

export function useAccessMatrix(): UseQueryResult<AccessMatrix> {
  return useQuery({ queryKey: adminKeys.access, queryFn: getAccessMatrix });
}

export interface ToggleAccessInput {
  libraryId: string;
  userId: string;
  /** true → grant, false → revoke. */
  grant: boolean;
}

/** Patches one user's granted library ids in a cached matrix. */
function patchMatrix(matrix: AccessMatrix, input: ToggleAccessInput): AccessMatrix {
  return {
    ...matrix,
    users: matrix.users.map((user) => {
      if (user.id !== input.userId) return user;
      const next = input.grant
        ? [...new Set([...user.libraryIds, input.libraryId])].sort()
        : user.libraryIds.filter((id) => id !== input.libraryId);
      return { ...user, libraryIds: next };
    }),
  };
}

/**
 * Grants or revokes one cell of the access matrix, updating the cached matrix
 * optimistically and reconciling on settle. Reverts on error.
 */
export function useToggleAccess(): UseMutationResult<
  void,
  Error,
  ToggleAccessInput,
  { previous: AccessMatrix | undefined }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ libraryId, userId, grant }) =>
      grant ? grantAccess(libraryId, userId) : revokeAccess(libraryId, userId),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: adminKeys.access });
      const previous = queryClient.getQueryData<AccessMatrix>(adminKeys.access);
      if (previous !== undefined) {
        queryClient.setQueryData<AccessMatrix>(adminKeys.access, patchMatrix(previous, input));
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(adminKeys.access, context.previous);
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: adminKeys.access }),
  });
}

// ---- Settings hooks ---------------------------------------------------------

export function useSettings(): UseQueryResult<AdminSettings> {
  return useQuery({ queryKey: adminKeys.settings, queryFn: getSettings });
}

export function useUpdateSettings(): UseMutationResult<AdminSettings, Error, SettingsPatch> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch) => updateSettings(patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(adminKeys.settings, settings);
      // serverName / registrationEnabled also power the public (login) settings.
      void queryClient.invalidateQueries({ queryKey: queryKeys.publicSettings });
    },
  });
}

// ---- Tasks hooks ------------------------------------------------------------

export function useTasks(): UseQueryResult<TaskStatus[]> {
  return useQuery({
    queryKey: adminKeys.tasks,
    queryFn: getTasks,
    // Poll while any task is running so its result/error lands without a manual
    // refresh; idle otherwise.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((task) => task.state === 'running') ? 2000 : false,
  });
}

export function useRunTask(): UseMutationResult<
  { started: boolean; taskId: string },
  Error,
  string
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => runTask(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminKeys.tasks }),
  });
}
