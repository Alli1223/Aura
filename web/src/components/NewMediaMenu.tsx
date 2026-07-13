import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router';

import { RECENTLY_ADDED_LIMIT, useRecentlyAdded } from '../api/home';
import { artworkSrc } from '../api/media';
import { useAuth } from '../auth/context';
import { AuthImage } from './AuthImage';
import { BellIcon } from './Icons';
import {
  countNew,
  newestAddedAt,
  readLastSeen,
  relativeAdded,
  writeLastSeen,
} from './newMedia';
import styles from './NewMediaMenu.module.css';

// Top-bar "new media" indicator: a bell with an unread-count badge over the
// cross-library recently-added feed. The badge counts items added since the
// user last opened the menu; that "last seen" marker is stored per-user in
// localStorage (so it is per-device). Opening the menu lists the recent items
// (each linking to its detail page) and marks everything seen, clearing the
// badge. It follows a keyboard-driven menu pattern (arrow nav, Esc, outside-
// click close) and degrades to an empty state for a user with no library access
// (no items → no badge). The pure helpers live in ./newMedia.

/** Largest number shown in the badge before it collapses to "N+". */
const BADGE_CAP = 9;
/** Background poll so freshly added items surface without a page reload. */
const REFETCH_INTERVAL_MS = 60_000;

export function NewMediaMenu() {
  const { user } = useAuth();
  const userId = user?.id ?? '';

  const query = useRecentlyAdded(RECENTLY_ADDED_LIMIT, { refetchInterval: REFETCH_INTERVAL_MS });
  const items = useMemo(() => query.data ?? [], [query.data]);

  const [lastSeen, setLastSeen] = useState<string | null>(() => readLastSeen(userId));
  const [trackedUserId, setTrackedUserId] = useState(userId);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const menuId = useId();

  // A different user starts fresh: re-read their own marker and drop any open UI
  // when the signed-in user changes. Adjusting state during render (rather than
  // in an effect) is the React-recommended way to reset on a prop change.
  if (trackedUserId !== userId) {
    setTrackedUserId(userId);
    setLastSeen(readLastSeen(userId));
    setOpen(false);
    setActiveIndex(-1);
  }

  const unseenCount = countNew(items, lastSeen);

  const markSeen = useCallback(() => {
    const newest = newestAddedAt(items);
    if (newest === null) return;
    writeLastSeen(userId, newest);
    setLastSeen(newest);
  }, [items, userId]);

  const closeMenu = useCallback((refocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Opening always marks everything seen, so the badge clears immediately.
  const openMenu = useCallback(() => {
    setOpen(true);
    setActiveIndex(-1);
    markSeen();
  }, [markSeen]);

  // Dismiss on any pointer press outside the whole control.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeMenu(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, closeMenu]);

  // Roving focus: move DOM focus onto the active item as arrow keys change it.
  useEffect(() => {
    if (open && activeIndex >= 0) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeMenu(true);
        }
        break;
      case 'ArrowDown':
        event.preventDefault();
        if (!open) {
          openMenu();
          break;
        }
        setActiveIndex((index) => Math.min(index + 1, items.length - 1));
        break;
      case 'ArrowUp':
        if (!open) break;
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case 'Home':
        if (open && items.length > 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (open && items.length > 0) {
          event.preventDefault();
          setActiveIndex(items.length - 1);
        }
        break;
      case 'Tab':
        // Let focus leave the menu naturally, but collapse it behind.
        if (open) closeMenu(false);
        break;
      default:
        break;
    }
  };

  const badgeText = unseenCount > BADGE_CAP ? `${BADGE_CAP}+` : String(unseenCount);
  const triggerLabel =
    unseenCount === 0
      ? 'Recently added'
      : `Recently added, ${unseenCount} new item${unseenCount === 1 ? '' : 's'}`;

  return (
    <div className={styles.container} ref={containerRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={triggerLabel}
        onClick={() => (open ? closeMenu(false) : openMenu())}
      >
        <BellIcon width={20} height={20} />
        {unseenCount > 0 && (
          <span className={styles.badge} aria-hidden="true">
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.menu} id={menuId} role="menu" aria-label="Recently added">
          <div className={styles.header} role="presentation">
            Recently added
          </div>

          {items.length === 0 ? (
            <p className={styles.empty}>
              {query.isError ? "Couldn't load new media" : 'No new media'}
            </p>
          ) : (
            <ul className={styles.list}>
              {items.map((item, index) => {
                const thumb = artworkSrc(item.posterUrl, 'w200');
                const yearSuffix = item.year !== null ? ` (${item.year})` : '';
                const added = relativeAdded(item.addedAt);
                return (
                  <li key={item.id}>
                    <Link
                      to={`/items/${item.id}`}
                      ref={(el) => {
                        itemRefs.current[index] = el;
                      }}
                      role="menuitem"
                      tabIndex={index === activeIndex ? 0 : -1}
                      className={styles.item}
                      aria-label={`${item.title}${yearSuffix}, added ${added}`}
                      onClick={() => closeMenu(false)}
                    >
                      <span className={styles.thumb} aria-hidden="true">
                        {thumb === null ? (
                          <span className={styles.thumbFallback}>{item.title.charAt(0)}</span>
                        ) : (
                          <AuthImage className={styles.thumbImage} src={thumb} alt="" />
                        )}
                      </span>
                      <span className={styles.text}>
                        <span className={styles.title}>
                          {item.title}
                          {item.year !== null && <span className={styles.year}> ({item.year})</span>}
                        </span>
                        <span className={styles.meta}>added {added}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
