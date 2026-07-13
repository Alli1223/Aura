// Intro/credits skip-marker derivation (skip-markers). A pure module: given a
// file's chapters and an optional per-show skip config, it produces the marker
// ranges the player uses to offer "Skip Intro" / "Skip Credits" buttons.
//
// Two independent sources feed the result, in priority order:
//
// 1. Chapter-based (preferred): a chapter whose title matches the intro pattern
//    becomes an intro marker over that chapter's [startMs, endMs]; one matching
//    the credits pattern becomes a credits marker. Non-matching chapters are
//    ignored. This is exact, so it always wins over the config fallback.
//
// 2. Per-show offset config (fallback): when the file has NO chapter marker for
//    a side, the show's admin-set offsets synthesise one — `introEndMs` yields
//    an intro [0, introEndMs]; `creditsStartMs` (absolute) or `creditsFromEndMs`
//    (measured back from the file's end) yields a credits marker that ends at
//    the file duration. A side with no config and no chapter simply has no
//    marker.
//
// The module never touches the database or the network; the media-query layer
// resolves the show's config and hands it in.

/** A marker is an intro (start of file) or the closing credits. */
export type SkipMarkerType = 'intro' | 'credits';

/** A derived skip range: `type` over `[startMs, endMs)` from the file start. */
export interface SkipMarker {
  type: SkipMarkerType;
  startMs: number;
  endMs: number;
}

/** The minimal chapter shape the classifier needs (title + range). */
export interface SkipChapter {
  startMs: number;
  endMs: number;
  title: string | null;
}

/**
 * A show's admin-set skip offsets. All values are milliseconds; `null` means
 * "unset" (no synthesised marker for that side).
 *
 * - `introEndMs`      — synthesise an intro marker `[0, introEndMs]`.
 * - `creditsStartMs`  — absolute start of the credits marker (ends at duration).
 * - `creditsFromEndMs`— credits start measured back from the end
 *                       (`duration - creditsFromEndMs`); used when the absolute
 *                       start is unset.
 *
 * `creditsStartMs` takes precedence over `creditsFromEndMs` when both are set.
 */
export interface SkipConfig {
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsFromEndMs: number | null;
}

export interface DeriveSkipMarkersInput {
  /** The file's chapters (any order); classified by title. */
  chapters: readonly SkipChapter[];
  /** The file duration in ms, or null when unknown (blocks credits synthesis). */
  durationMs: number | null;
  /** The show's skip config, or null when none is set (chapters only). */
  config: SkipConfig | null;
}

// A title is an intro if it STARTS with one of these keywords (anchored so
// "operation" is not mistaken for "op"). Covers anime "OP"/opening themes,
// "recap" / "previously on …" cold opens.
const INTRO_PATTERN = /^\s*(intro|opening|op|recap|previously)\b/i;

// A title is credits if it CONTAINS one of these as a whole word (word-bounded
// so "ed" matches an anime ending theme but not "wedding"). Covers closing
// credits, "outro", and "next episode" previews.
const CREDITS_PATTERN = /\b(credits|ending|ed|outro|preview|next\s*episode)\b/i;

/**
 * Classifies a chapter title as an intro, credits or neither. Intro is checked
 * first so an ambiguous title leans to intro. Returns null for blank/absent
 * titles or titles that match no pattern.
 */
export function classifyChapterTitle(title: string | null): SkipMarkerType | null {
  if (title === null) return null;
  const trimmed = title.trim();
  if (trimmed === '') return null;
  if (INTRO_PATTERN.test(trimmed)) return 'intro';
  if (CREDITS_PATTERN.test(trimmed)) return 'credits';
  return null;
}

/**
 * Derives the intro/credits skip markers for a file. Chapter-classified markers
 * win; the per-show config only fills a side that has no chapter marker. Markers
 * are returned sorted by start time; a side is omitted when neither a chapter
 * nor usable config supplies it.
 */
export function deriveSkipMarkers(input: DeriveSkipMarkersInput): SkipMarker[] {
  const { chapters, durationMs, config } = input;
  const markers: SkipMarker[] = [];
  let hasIntro = false;
  let hasCredits = false;

  for (const chapter of chapters) {
    const type = classifyChapterTitle(chapter.title);
    if (type === null) continue;
    const startMs = Math.max(0, chapter.startMs);
    const endMs = Math.max(startMs, chapter.endMs);
    // A zero-length range can never contain the playhead — skip it so the config
    // fallback may still fill that side.
    if (endMs <= startMs) continue;
    markers.push({ type, startMs, endMs });
    if (type === 'intro') hasIntro = true;
    else hasCredits = true;
  }

  if (config !== null) {
    // Intro fallback: [0, introEndMs], clamped to the duration when known.
    if (!hasIntro && config.introEndMs !== null && config.introEndMs > 0) {
      const end =
        durationMs !== null && durationMs > 0
          ? Math.min(config.introEndMs, durationMs)
          : config.introEndMs;
      if (end > 0) markers.push({ type: 'intro', startMs: 0, endMs: end });
    }
    // Credits fallback needs a known duration for the marker's end.
    if (!hasCredits && durationMs !== null && durationMs > 0) {
      let start: number | null = null;
      if (config.creditsStartMs !== null) start = config.creditsStartMs;
      else if (config.creditsFromEndMs !== null && config.creditsFromEndMs > 0) {
        start = durationMs - config.creditsFromEndMs;
      }
      if (start !== null) {
        const clampedStart = Math.min(Math.max(0, start), durationMs);
        if (clampedStart < durationMs) {
          markers.push({ type: 'credits', startMs: clampedStart, endMs: durationMs });
        }
      }
    }
  }

  markers.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return markers;
}
