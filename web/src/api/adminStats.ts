import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiRequest } from './client';

// Data layer for the admin server-wide statistics dashboard:
//   GET /api/admin/stats  (admin-only) → AdminStats
// A read-only snapshot of counts, per-library storage, most-watched items,
// most-active users and recently-added counts. Mirrors lib/admin-stats.ts.

/** Per-media-item-type counts plus the grand total. */
export interface ItemTypeCounts {
  movie: number;
  show: number;
  season: number;
  episode: number;
  total: number;
}

export interface StatsTotals {
  users: number;
  libraries: number;
  files: number;
  items: ItemTypeCounts;
}

export interface LibraryStorage {
  libraryId: string;
  name: string;
  type: string;
  fileCount: number;
  /** Total bytes across the library's files (a JSON number over the wire). */
  totalBytes: number;
}

export interface MostWatchedItem {
  mediaItemId: string;
  title: string;
  type: string;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  playCount: number;
  viewers: number;
}

export interface MostActiveUser {
  userId: string;
  username: string;
  playCount: number;
  itemCount: number;
}

export interface RecentlyAddedCounts {
  last24h: number;
  last7d: number;
  last30d: number;
}

export interface AdminStats {
  totals: StatsTotals;
  storageByLibrary: LibraryStorage[];
  mostWatched: MostWatchedItem[];
  mostActiveUsers: MostActiveUser[];
  recentlyAdded: RecentlyAddedCounts;
}

/**
 * Formats a byte count as a human-readable size (binary units). Small values
 * stay in whole bytes; larger ones show one decimal (e.g. "3.9 KB", "2.0 GB").
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// ---- Client -----------------------------------------------------------------

export function getAdminStats(): Promise<AdminStats> {
  return apiRequest<AdminStats>('/admin/stats');
}

// ---- Query keys + hook ------------------------------------------------------

export const adminStatsKeys = {
  all: ['admin', 'stats'] as const,
};

export function useAdminStats(): UseQueryResult<AdminStats> {
  return useQuery({ queryKey: adminStatsKeys.all, queryFn: getAdminStats });
}
