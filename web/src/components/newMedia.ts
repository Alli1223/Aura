import type { MediaItem } from '../api/media';

// Pure helpers behind the top-bar "new media" indicator (NewMediaMenu): the
// per-user last-seen marker persisted in localStorage plus the unread-count and
// relative-time formatting. Kept in a plain module (no component export) so the
// component file stays fast-refresh clean and these stay unit-testable.

const SEEN_KEY_PREFIX = 'aura:new-media-last-seen:';

/**
 * localStorage key holding a user's last-seen recently-added timestamp. The
 * marker is per-user AND per-device: it lives only in this browser's storage.
 */
export function newMediaSeenKey(userId: string): string {
  return `${SEEN_KEY_PREFIX}${userId}`;
}

export function readLastSeen(userId: string): string | null {
  try {
    return localStorage.getItem(newMediaSeenKey(userId));
  } catch {
    // Storage unavailable (private mode / disabled): behave as never-seen.
    return null;
  }
}

export function writeLastSeen(userId: string, iso: string): void {
  try {
    localStorage.setItem(newMediaSeenKey(userId), iso);
  } catch {
    // Ignore: the badge simply won't persist across reloads on this device.
  }
}

/** Newest `addedAt` across the items (ISO strings sort lexically), or null. */
export function newestAddedAt(items: MediaItem[]): string | null {
  let newest: string | null = null;
  for (const item of items) {
    if (newest === null || item.addedAt > newest) newest = item.addedAt;
  }
  return newest;
}

/** Items added strictly after the last-seen marker (all of them when unseen). */
export function countNew(items: MediaItem[], lastSeen: string | null): number {
  if (lastSeen === null) return items.length;
  return items.reduce((n, item) => (item.addedAt > lastSeen ? n + 1 : n), 0);
}

/** "just now" / "3 hours ago"-style label for an added timestamp. */
export function relativeAdded(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month} month${month === 1 ? '' : 's'} ago`;
  const year = Math.round(month / 12);
  return `${year} year${year === 1 ? '' : 's'} ago`;
}
