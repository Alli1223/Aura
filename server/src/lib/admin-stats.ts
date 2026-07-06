import { getPrisma } from '../db/client.js';
import { MEDIA_ITEM_TYPES } from '../db/constants.js';

// Server-wide statistics for the admin dashboard. Admin-only (the route composes
// [authenticate, requireAdmin]); this module is pure aggregation and assumes the
// caller is an admin, so it deliberately spans every user and library.
//
// Every figure comes from a Prisma aggregate/groupBy (never an in-memory scan of
// full tables) and the top-N lists are capped, so the endpoint stays cheap even
// on a large library.

/** Cap on the "most watched" and "most active users" lists. */
export const TOP_N = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Per-media-item-type counts, plus the grand total. */
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

/** Aggregate storage for one library (sum of its files' sizes). */
export interface LibraryStorage {
  libraryId: string;
  name: string;
  type: string;
  fileCount: number;
  /** Total bytes across the library's files (BigInt in the DB, JSON number here). */
  totalBytes: number;
}

/** One "most watched" leaf item with its aggregate play counts. */
export interface MostWatchedItem {
  mediaItemId: string;
  title: string;
  type: string;
  /** Episode only: its show's title for context (null for movies). */
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** Sum of playCount across all users. */
  playCount: number;
  /** Distinct users who have watched it at least once. */
  viewers: number;
}

/** One "most active" user by aggregate play count. */
export interface MostActiveUser {
  userId: string;
  username: string;
  playCount: number;
  /** Number of distinct items the user has watched. */
  itemCount: number;
}

/** Recently-added top-level item counts over rolling windows. */
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

/** Sum + count of every file backing items in one library. */
async function libraryStorage(library: {
  id: string;
  name: string;
  type: string;
}): Promise<LibraryStorage> {
  const aggregate = await getPrisma().mediaFile.aggregate({
    where: { mediaItem: { libraryId: library.id } },
    _sum: { size: true },
    _count: { _all: true },
  });
  return {
    libraryId: library.id,
    name: library.name,
    type: library.type,
    fileCount: aggregate._count._all,
    totalBytes: Number(aggregate._sum.size ?? 0n),
  };
}

/** Per-type item counts from a single groupBy, defaulting absent types to 0. */
async function itemTypeCounts(): Promise<ItemTypeCounts> {
  const groups = await getPrisma().mediaItem.groupBy({ by: ['type'], _count: { _all: true } });
  const byType = new Map(groups.map((group) => [group.type, group._count._all]));
  const counts: ItemTypeCounts = { movie: 0, show: 0, season: 0, episode: 0, total: 0 };
  for (const type of MEDIA_ITEM_TYPES) {
    counts[type] = byType.get(type) ?? 0;
    counts.total += counts[type];
  }
  return counts;
}

/** Top-N most-watched leaf items, resolved to titles + show context. */
async function mostWatched(): Promise<MostWatchedItem[]> {
  const prisma = getPrisma();
  // Aggregate playCount per item across every user; only rows with a real play
  // (playCount > 0) count toward "watched", so in-progress-only items are out.
  const groups = await prisma.watchState.groupBy({
    by: ['mediaItemId'],
    where: { playCount: { gt: 0 } },
    _sum: { playCount: true },
    _count: { _all: true },
    orderBy: [{ _sum: { playCount: 'desc' } }, { mediaItemId: 'asc' }],
    take: TOP_N,
  });
  if (groups.length === 0) return [];

  const items = await prisma.mediaItem.findMany({
    where: { id: { in: groups.map((group) => group.mediaItemId) } },
    select: {
      id: true,
      title: true,
      type: true,
      seasonNumber: true,
      episodeNumber: true,
      parent: { select: { type: true, title: true, parentId: true } },
    },
  });
  const byId = new Map(items.map((item) => [item.id, item]));

  // Resolve missing show titles (episode -> season -> show) in one batched hop.
  const seasonParentIds = [
    ...new Set(
      items
        .filter((item) => item.parent?.type === 'season' && item.parent.parentId !== null)
        .map((item) => item.parent!.parentId as string),
    ),
  ];
  const showTitles = new Map<string, string>();
  if (seasonParentIds.length > 0) {
    const shows = await prisma.mediaItem.findMany({
      where: { id: { in: seasonParentIds } },
      select: { id: true, title: true },
    });
    for (const show of shows) showTitles.set(show.id, show.title);
  }

  return groups.flatMap((group) => {
    const item = byId.get(group.mediaItemId);
    if (item === undefined) return [];
    let showTitle: string | null = null;
    if (item.parent?.type === 'show') showTitle = item.parent.title;
    else if (item.parent?.type === 'season' && item.parent.parentId !== null) {
      showTitle = showTitles.get(item.parent.parentId) ?? null;
    }
    return [
      {
        mediaItemId: item.id,
        title: item.title,
        type: item.type,
        showTitle,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        playCount: group._sum.playCount ?? 0,
        viewers: group._count._all,
      },
    ];
  });
}

/** Top-N users by aggregate play count, resolved to usernames. */
async function mostActiveUsers(): Promise<MostActiveUser[]> {
  const prisma = getPrisma();
  const groups = await prisma.watchState.groupBy({
    by: ['userId'],
    where: { playCount: { gt: 0 } },
    _sum: { playCount: true },
    _count: { _all: true },
    orderBy: [{ _sum: { playCount: 'desc' } }, { userId: 'asc' }],
    take: TOP_N,
  });
  if (groups.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: groups.map((group) => group.userId) } },
    select: { id: true, username: true },
  });
  const usernames = new Map(users.map((user) => [user.id, user.username]));

  return groups.flatMap((group) => {
    const username = usernames.get(group.userId);
    if (username === undefined) return [];
    return [
      {
        userId: group.userId,
        username,
        playCount: group._sum.playCount ?? 0,
        itemCount: group._count._all,
      },
    ];
  });
}

/** Top-level items added within the last 24h / 7d / 30d. */
async function recentlyAdded(): Promise<RecentlyAddedCounts> {
  const prisma = getPrisma();
  const now = Date.now();
  const topLevel = { parentId: null, type: { in: ['movie', 'show'] } };
  const [last24h, last7d, last30d] = await Promise.all([
    prisma.mediaItem.count({ where: { ...topLevel, addedAt: { gte: new Date(now - DAY_MS) } } }),
    prisma.mediaItem.count({
      where: { ...topLevel, addedAt: { gte: new Date(now - 7 * DAY_MS) } },
    }),
    prisma.mediaItem.count({
      where: { ...topLevel, addedAt: { gte: new Date(now - 30 * DAY_MS) } },
    }),
  ]);
  return { last24h, last7d, last30d };
}

/** Assembles the full admin statistics payload. */
export async function getAdminStats(): Promise<AdminStats> {
  const prisma = getPrisma();

  const [userCount, libraries, fileCount, items, mostWatchedItems, activeUsers, recent] =
    await Promise.all([
      prisma.user.count(),
      prisma.library.findMany({
        select: { id: true, name: true, type: true },
        orderBy: { name: 'asc' },
      }),
      prisma.mediaFile.count(),
      itemTypeCounts(),
      mostWatched(),
      mostActiveUsers(),
      recentlyAdded(),
    ]);

  const storageByLibrary = await Promise.all(libraries.map(libraryStorage));
  // Largest library first — the useful order for a storage table.
  storageByLibrary.sort((a, b) => b.totalBytes - a.totalBytes);

  return {
    totals: {
      users: userCount,
      libraries: libraries.length,
      files: fileCount,
      items,
    },
    storageByLibrary,
    mostWatched: mostWatchedItems,
    mostActiveUsers: activeUsers,
    recentlyAdded: recent,
  };
}
