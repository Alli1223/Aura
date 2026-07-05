import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router';

import { artworkSrc, type MediaItem } from '../api/media';
import { useLibraries } from '../api/queries';
import { MIN_SEARCH_LENGTH, useSearch } from '../api/search';
import { AuthImage } from './AuthImage';
import { SearchIcon } from './Icons';
import styles from './SearchBox.module.css';

// The top-bar search box: a debounced instant-results dropdown over GET
// /api/search plus a keyboard-driven path to the full results page. It follows
// the ARIA combobox/listbox pattern — the input owns focus and drives an active
// descendant, the options are non-focusable rows referenced by id. ↑/↓ move the
// selection, Enter opens the active item (or, with none active, the full results
// page), Esc closes, and an outside click dismisses it.

/** Debounce before the dropdown query fires (ms). */
const SEARCH_DEBOUNCE_MS = 250;
/** How many instant matches the dropdown shows. */
const DROPDOWN_LIMIT = 6;

/** Human label for an item's type ('movie' → 'Movie'). */
function typeLabel(type: string): string {
  return type.length === 0 ? '' : type[0]!.toUpperCase() + type.slice(1);
}

export function SearchBox() {
  const navigate = useNavigate();
  const libraries = useLibraries();

  const [value, setValue] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const trimmed = value.trim();
  const canSearch = trimmed.length >= MIN_SEARCH_LENGTH;

  // Debounce the term that actually hits the API; the input updates instantly.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);

  const query = useSearch(debounced, { enabled: open && canSearch, limit: DROPDOWN_LIMIT });
  const results = canSearch ? (query.data?.results ?? []) : [];

  // The dropdown is visible only while open with a long-enough term.
  const showDropdown = open && canSearch;

  // Dismiss on any click outside the whole search widget.
  useEffect(() => {
    if (!showDropdown) return;
    function onPointerDown(event: MouseEvent) {
      if (wrapperRef.current !== null && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showDropdown]);

  const libraryName = (libraryId: string): string | undefined =>
    libraries.data?.find((library) => library.id === libraryId)?.name;

  const closeAndClear = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const goToItem = (item: MediaItem) => {
    closeAndClear();
    navigate(`/items/${item.id}`);
  };

  const goToAllResults = () => {
    if (trimmed === '') return;
    closeAndClear();
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  const onChange = (next: string) => {
    setValue(next);
    setActiveIndex(-1);
    setOpen(next.trim().length >= MIN_SEARCH_LENGTH);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // "See all results" is the row after the last match, so the last navigable
    // index is results.length (─1 = the input itself, nothing selected).
    const lastIndex = results.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!showDropdown && canSearch) {
          setOpen(true);
          return;
        }
        setActiveIndex((index) => Math.min(index + 1, lastIndex));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, -1));
        break;
      case 'Enter':
        event.preventDefault();
        if (showDropdown && activeIndex >= 0 && activeIndex < results.length) {
          goToItem(results[activeIndex]!);
        } else {
          goToAllResults();
        }
        break;
      case 'Escape':
        if (showDropdown) {
          event.preventDefault();
          setOpen(false);
          setActiveIndex(-1);
        }
        break;
      default:
        break;
    }
  };

  const seeAllId = `${listboxId}-all`;
  const optionId = (index: number): string => `${listboxId}-opt-${index}`;
  const activeDescendant =
    !showDropdown || activeIndex < 0
      ? undefined
      : activeIndex >= results.length
        ? seeAllId
        : optionId(activeIndex);

  return (
    <div className={styles.search} ref={wrapperRef}>
      <div className={styles.inputWrap}>
        <SearchIcon className={styles.icon} width={18} height={18} />
        <input
          type="search"
          className={styles.input}
          placeholder="Search"
          aria-label="Search"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => canSearch && setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>

      {showDropdown && (
        <div className={styles.dropdown}>
          <ul className={styles.listbox} id={listboxId} role="listbox" aria-label="Search results">
            {query.isPending && (
              <li className={styles.status} role="status">
                Searching…
              </li>
            )}

            {!query.isPending && results.length === 0 && (
              <li className={styles.status} role="status">
                No results for “{trimmed}”
              </li>
            )}

            {results.map((item, index) => {
              const meta = [typeLabel(item.type), libraryName(item.libraryId)]
                .filter((part) => part !== undefined && part !== '')
                .join(' · ');
              const yearSuffix = item.year !== null ? ` (${item.year})` : '';
              // An explicit label keeps the accessible name well-spaced and
              // stable (the accname algorithm otherwise drops the year's space).
              const label = [`${item.title}${yearSuffix}`, meta].filter((part) => part !== '').join(', ');
              const thumb = artworkSrc(item.posterUrl, 'w200');
              return (
                <li key={item.id} className={styles.optionItem}>
                  <Link
                    to={`/items/${item.id}`}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === activeIndex}
                    aria-label={label}
                    tabIndex={-1}
                    className={`${styles.option} ${index === activeIndex ? styles.active : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => closeAndClear()}
                  >
                    <span className={styles.thumb} aria-hidden="true">
                      {thumb === null ? (
                        <span className={styles.thumbFallback}>{item.title.charAt(0)}</span>
                      ) : (
                        <AuthImage className={styles.thumbImage} src={thumb} alt="" />
                      )}
                    </span>
                    <span className={styles.optionText}>
                      <span className={styles.optionTitle}>
                        {item.title}
                        {item.year !== null && <span className={styles.optionYear}> ({item.year})</span>}
                      </span>
                      {meta !== '' && <span className={styles.optionMeta}>{meta}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}

            <li className={styles.optionItem}>
              <Link
                to={`/search?q=${encodeURIComponent(trimmed)}`}
                id={seeAllId}
                role="option"
                aria-selected={activeIndex === results.length}
                tabIndex={-1}
                className={`${styles.seeAll} ${activeIndex === results.length ? styles.active : ''}`}
                onMouseEnter={() => setActiveIndex(results.length)}
                onClick={() => closeAndClear()}
              >
                See all results for “{trimmed}”
              </Link>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
