// Pure filename/path parsing for the media scanner.
//
// Turns library-root-relative file paths into structured identification
// without touching the filesystem, database, or ffprobe. Both entry points
// are guaranteed to never throw: worst case they return a ParsedUnknown
// with a best-effort cleaned title.

export type ParsedMovie = {
  type: 'movie';
  title: string;
  year?: number;
  releaseGroup?: string;
};

export type ParsedEpisode = {
  type: 'episode';
  showTitle?: string;
  season?: number;
  episode: number;
  episodeEnd?: number;
  absolute?: boolean;
  year?: number;
  version?: number;
  releaseGroup?: string;
  episodeTitle?: string;
};

export type ParsedUnknown = {
  type: 'unknown';
  title: string;
};

export type EpisodeParseOptions = {
  /** Enables anime absolute-numbering, [Group] prefixes and OVA/NC markers. */
  anime?: boolean;
};

// ---------------------------------------------------------------------------
// Scene-noise vocabulary
// ---------------------------------------------------------------------------

// Tokens that unambiguously mark the start of release junk. Matched against
// whole tokens only (after dots/underscores have become spaces).
const STRONG_TAG_RE = new RegExp(
  '^(?:' +
    [
      '\\d{3,4}[pi]', // 720p, 1080p, 2160p, 1080i
      '\\d{3,4}x\\d{3,4}', // pixel dimensions, e.g. 1920x1080
      '4k',
      '8k',
      'uhd',
      // sources
      'blu-?ray',
      'bd-?rip',
      'br-?rip',
      'bd-?remux',
      'remux',
      'web-?dl',
      'web-?rip',
      'hdtv',
      'pdtv',
      'sdtv',
      'dvd-?rip',
      'dvd',
      'hd-?rip',
      'dvdscr',
      'screener',
      'telesync',
      'telecine',
      'hdcam',
      'cam-?rip',
      // streaming service tags
      'amzn',
      'nf',
      'dsnp',
      'hulu',
      'atvp',
      'hmax',
      'itunes',
      // video codecs
      'x264',
      'x265',
      'h264',
      'h265',
      'hevc',
      'avc',
      'av1',
      'xvid',
      'divx',
      'vp9',
      // audio
      'dts(?:-?(?:hd|x|es|ma))?',
      'aac2?',
      'ac-?3',
      'e-?ac-?3',
      'dd[p+]?(?:\\d(?:\\.\\d)?)?',
      'true-?hd',
      'atmos',
      'flac',
      'mp3',
      'opus',
      'pcm',
      '\\d(?:\\.\\d)?ch',
      // dynamic range / bit depth
      'hdr10\\+?',
      'hdr',
      'dovi',
      'dolbyvision',
      'dv',
      'sdr',
      '\\d{1,2}-?bit',
      'hi10p?',
      // release flags
      'proper',
      'repack',
      'rerip',
      'extended',
      'unrated',
      'uncut',
      'remastered',
      'remaster',
      'limited',
      'internal',
      'retail',
      'complete',
      'multi',
      'dual',
      'dubbed',
      'subbed',
      'imax',
      'criterion',
      // canonical forms produced by phrase pre-processing in tokenize()
      'directorscut',
      'extendedcut',
    ].join('|') +
    ')$',
  'i',
);

// Extra tokens that count as junk only inside (...) or [...] groups, where
// the risk of eating a real title is negligible.
const WEAK_GROUP_TAG_RE = /^(?:tv|bd|web|dl|ma|hd|sd|uncensored|batch|eng|jap|jpn|dual[ -]?audio|multiple|subtitle[sd]?)$/i;

const YEAR_TOKEN_RE = /^(?:19|20)\d{2}$/;
const PAREN_YEAR_RE = /\(\s*((?:19|20)\d{2})\s*\)/g;
const SEPARATOR_TOKEN_RE = /^[-–—~]+$/;

// ---------------------------------------------------------------------------
// Episode patterns
// ---------------------------------------------------------------------------

// S01E02 / s1e2 / S01.E02 / S01E01E02 / S01E01-E02 / S01E01-02 / S01E02v2
const SXXEYY_RE =
  /(?<![a-z0-9])s(\d{1,2})[ ._-]{0,3}e(\d{1,3})(?:v(\d+))?((?:[ ._-]{0,3}e\d{1,3}|-\d{1,3})*)(?!\d)/i;

// 1x02 — digit guards keep 1920x1080 and x264 from matching.
const NXM_RE = /(?<![\dx])(\d{1,2})x(\d{2,3})(?!\d)/i;
const NXM_RANGE_TIGHT_RE = /^-(?:\d{1,2}x)?(\d{2,3})(?!\d)/i;
// With spaces around the dash the full NxM form is required, so that
// "Show 1x01 - 22 Short Films" does not become a range.
const NXM_RANGE_FULL_RE = /^\s*-\s*\d{1,2}x(\d{2,3})(?!\d)/i;

// "Episode 5" / "Ep 5" anywhere; bare "E05" only at the start of the name.
const EPISODE_WORD_RE = /(?<![a-z])(?:ep|episode)[ ._-]*(\d{1,3})(?!\d)/i;
const LEADING_E_RE = /^e[ ._-]*(\d{1,3})(?!\d)/i;

// Bare "02" / "01-02" at the start of a name inside a season folder.
const BARE_NUMBER_RE = /^(\d{1,3})(?:-(\d{1,3}))?(?![a-z0-9])/i;

const SEASON_WORD_RE = /(?<![a-z])(?:season|series)[ ._-]*(\d{1,3})(?!\d)/i;

// Anime absolute numbering: " - 12", " - 12v2", " - 01-02", " - 12.5".
const ABSOLUTE_RE =
  /-[ ._]*(\d{1,4})(\.\d+)?(?:[ ._]*v(\d+))?(?![a-z0-9])(?:[ ._]*-[ ._]*(\d{1,4})(\.\d+)?(?![a-z0-9]))?/gi;

// OVA/OAD/NCED/NCOP/SPxx special markers (anime).
const SPECIAL_MARKER_RE = /(?<![a-z])(ova|oad|nced|ncop|sp)[ ._-]*(\d{1,3})?(?![a-z0-9])/i;
const KEEP_BRACKET_CONTENT_RE = /^(?:ova|oad|nced|ncop|specials?|sp[ ._-]*\d{0,3})$/i;

const SEASON_DIR_RE = /^(?:season|series|saison|staffel)[ ._-]*(\d{1,3})(?![a-z0-9])/i;
const SEASON_DIR_SHORT_RE = /^s(\d{1,2})$/i;
const SPECIALS_DIR_RE = /^specials?$/i;

const SAMPLE_RE = /(?:^|[ ._-])sample$/i;

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function splitPath(relPath: string): string[] {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Splits "name.ext" — the extension must be 2-5 alphanumerics with at least one letter. */
function splitExtension(fileName: string): { base: string; ext: string } | undefined {
  const match = /^(.+)\.([a-z0-9]{2,5})$/i.exec(fileName);
  const base = match?.[1];
  const ext = match?.[2];
  if (base === undefined || ext === undefined || !/[a-z]/i.test(ext)) return undefined;
  return { base, ext };
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function matchIndex(match: RegExpMatchArray): number {
  return match.index ?? 0;
}

/** Dots/underscores → spaces, with channel/codec dot-forms handled first. */
function tokenize(value: string): string[] {
  const prepared = value
    .replace(/\bh[ ._]?26([45])\b/gi, ' h26$1 ')
    .replace(/(?<!\d)[2579]\.[01](?!\d)/g, ' ') // 2.0 / 5.1 / 7.1 audio channels
    .replace(/\bdirectors?['’]?[ ._-]cut\b/gi, ' DIRECTORSCUT ')
    .replace(/\bextended[ ._-](?:cut|edition)\b/gi, ' EXTENDEDCUT ')
    .replace(/[._]/g, ' ');
  return prepared.split(/\s+/).filter((token) => token.length > 0);
}

/** True when the string carries scene-release markers (tags, year, SxxEyy). */
function hasSceneMarkers(value: string): boolean {
  if (SXXEYY_RE.test(value)) return true;
  return tokenize(value).some(
    (token, i) => STRONG_TAG_RE.test(token) || (i > 0 && YEAR_TOKEN_RE.test(token)),
  );
}

/**
 * Captures a trailing scene release group ("...x264-GROUP"). Only fires when
 * the rest of the name carries scene markers, so hyphenated titles like
 * "Spider-Man" are left alone.
 */
function extractTrailingGroup(value: string): { rest: string; group?: string } {
  const match = /-([a-z][a-z0-9]*|\d+[a-z][a-z0-9]*)\s*$/i.exec(value);
  const group = match?.[1];
  // The whole trailing chunk must not itself be a scene tag, so "WEB-DL" or
  // "DTS-HD" endings are not mistaken for "-GROUP".
  const trailingChunk = /[^ ._]*$/.exec(value.trimEnd())?.[0] ?? '';
  if (
    match !== null &&
    group !== undefined &&
    group.length >= 2 &&
    match.index > 0 &&
    !STRONG_TAG_RE.test(trailingChunk) &&
    // "-E02" / "-1x02" endings are multi-episode markers, not groups.
    !/^(?:e\d{1,3}|\d{1,2}x\d{2,3})$/i.test(group) &&
    hasSceneMarkers(value.slice(0, match.index))
  ) {
    return { rest: value.slice(0, match.index), group };
  }
  return { rest: value };
}

/** Removes (...) groups whose entire content is junk tags (e.g. "(1080p)"). */
function removeJunkParens(value: string): string {
  return value.replace(/\(([^)]*)\)/g, (full, inner: string) => {
    const tokens = tokenize(inner);
    if (
      tokens.length > 0 &&
      tokens.every(
        (token) =>
          STRONG_TAG_RE.test(token) || WEAK_GROUP_TAG_RE.test(token) || YEAR_TOKEN_RE.test(token),
      )
    ) {
      return ' ';
    }
    return full;
  });
}

/** Removes [...] groups, keeping special-marker contents like "[OVA]". */
function removeBrackets(value: string): string {
  return value.replace(/\[([^\]]*)\]/g, (_full, inner: string) =>
    KEEP_BRACKET_CONTENT_RE.test(inner.trim()) ? ` ${inner.trim()} ` : ' ',
  );
}

/**
 * Best-effort human-readable cleanup for unknown results: drops brackets and
 * "(YYYY)" years, converts separators, but keeps digit.digit ("12.5") intact.
 */
function bestEffortTitle(value: string): string {
  return value
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(PAREN_YEAR_RE, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type CleanNameResult = { title: string; year?: number; releaseGroup?: string };

/**
 * Cleans a movie-like name (also used for show folders and episode prefixes):
 * strips bracket junk, captures a trailing release group, extracts the year
 * and cuts scene tags, preserving the title's own casing and inner years.
 */
function cleanName(name: string): CleanNameResult {
  let working = removeBrackets(name);

  let releaseGroup: string | undefined;
  const grouped = extractTrailingGroup(working);
  if (grouped.group !== undefined) {
    releaseGroup = grouped.group;
    working = grouped.rest;
  }

  // Parenthesised year: the last "(YYYY)" wins and everything after it is junk.
  let year: number | undefined;
  let lastParenYear: RegExpMatchArray | undefined;
  for (const match of working.matchAll(PAREN_YEAR_RE)) lastParenYear = match;
  if (lastParenYear !== undefined) {
    year = toInt(lastParenYear[1]);
    working = working.slice(0, matchIndex(lastParenYear));
  }

  working = removeJunkParens(working);

  let tokens = tokenize(working);

  // Standalone year: the last delimited 19xx/20xx token that is not the very
  // first token — "Blade.Runner.2049.2017" keeps 2049 and takes 2017.
  if (year === undefined) {
    let yearIdx = -1;
    tokens.forEach((token, i) => {
      if (i > 0 && YEAR_TOKEN_RE.test(token)) yearIdx = i;
    });
    if (yearIdx > 0) {
      year = toInt(tokens[yearIdx]);
      tokens = tokens.slice(0, yearIdx);
    }
  }

  // Everything from the first strong tag onwards is junk.
  const tagIdx = tokens.findIndex((token) => STRONG_TAG_RE.test(token));
  if (tagIdx >= 0) tokens = tokens.slice(0, tagIdx);

  while (tokens.length > 0 && SEPARATOR_TOKEN_RE.test(tokens[0] ?? '')) tokens.shift();
  while (tokens.length > 0 && SEPARATOR_TOKEN_RE.test(tokens.at(-1) ?? '')) tokens.pop();

  const result: CleanNameResult = { title: tokens.join(' ').trim() };
  if (year !== undefined) result.year = year;
  if (releaseGroup !== undefined) result.releaseGroup = releaseGroup;
  return result;
}

// ---------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------

/**
 * Parses a movie file path (relative to the library root).
 * Folder context wins: "Inception (2010)/anything.mkv" is titled from the folder.
 */
export function parseMoviePath(relPath: string): ParsedMovie | ParsedUnknown {
  try {
    const segments = splitPath(relPath);
    const fileName = segments.at(-1);
    if (fileName === undefined) return { type: 'unknown', title: '' };
    if (fileName.startsWith('.')) return { type: 'unknown', title: fileName };

    const split = splitExtension(fileName);
    if (split === undefined) return { type: 'unknown', title: bestEffortTitle(fileName) };
    const base = split.base;
    if (SAMPLE_RE.test(base)) return { type: 'unknown', title: bestEffortTitle(base) };

    const fromFile = cleanName(base);
    const folderName = segments.length > 1 ? segments.at(-2) : undefined;
    const fromFolder =
      folderName !== undefined && !folderName.startsWith('.') ? cleanName(folderName) : undefined;

    let title = fromFile.title;
    let year = fromFile.year;
    if (fromFolder !== undefined && fromFolder.title.length > 0) {
      title = fromFolder.title;
      year = fromFolder.year ?? fromFile.year;
    }
    const releaseGroup = fromFile.releaseGroup ?? fromFolder?.releaseGroup;

    if (title.length === 0) {
      return { type: 'unknown', title: bestEffortTitle(base) };
    }

    const result: ParsedMovie = { type: 'movie', title };
    if (year !== undefined) result.year = year;
    if (releaseGroup !== undefined) result.releaseGroup = releaseGroup;
    return result;
  } catch {
    return { type: 'unknown', title: safeFallbackTitle(relPath) };
  }
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

type EpisodeDraft = {
  episode: number;
  season?: number;
  episodeEnd?: number;
  absolute?: boolean;
  version?: number;
  prefix: string;
  suffix: string;
};

type EpisodeContext = {
  folderSeason?: number;
  showInfo?: CleanNameResult;
  parenYear?: number;
  releaseGroup?: string;
};

/**
 * Parses an episode file path (relative to the library root). Show and season
 * folders supply context; `opts.anime` additionally enables absolute
 * numbering, leading [Group] tags, versions and OVA/NC special markers.
 */
export function parseEpisodePath(
  relPath: string,
  opts?: EpisodeParseOptions,
): ParsedEpisode | ParsedUnknown {
  try {
    const anime = opts?.anime === true;
    const segments = splitPath(relPath);
    const fileName = segments.at(-1);
    if (fileName === undefined) return { type: 'unknown', title: '' };
    if (fileName.startsWith('.')) return { type: 'unknown', title: fileName };

    const split = splitExtension(fileName);
    if (split === undefined) return { type: 'unknown', title: bestEffortTitle(fileName) };
    const base = split.base;
    if (SAMPLE_RE.test(base)) return { type: 'unknown', title: bestEffortTitle(base) };

    // Folder context: ".../Show (2019)/Season 1/<file>".
    const parents = segments.slice(0, -1);
    let folderSeason: number | undefined;
    let showDirName: string | undefined;
    const lastParent = parents.at(-1);
    if (lastParent !== undefined) {
      const dirSeason = parseSeasonDirName(lastParent);
      if (dirSeason !== undefined) {
        folderSeason = dirSeason;
        showDirName = parents.at(-2);
      } else {
        showDirName = lastParent;
      }
    }
    const showInfo =
      showDirName !== undefined && !showDirName.startsWith('.')
        ? cleanName(showDirName)
        : undefined;

    let work = base;
    let releaseGroup: string | undefined;

    // Anime fansub convention: leading "[Group] ...".
    if (anime) {
      const groupMatch = /^\s*\[([^\]]*)\]/.exec(work);
      const group = groupMatch?.[1]?.trim();
      if (groupMatch !== null && group !== undefined && group.length > 0) {
        releaseGroup = group;
        work = work.slice(groupMatch[0].length);
      }
    }
    if (releaseGroup === undefined) {
      const grouped = extractTrailingGroup(work);
      if (grouped.group !== undefined) {
        releaseGroup = grouped.group;
        work = grouped.rest;
      }
    }

    // "(2019)" anywhere in the name is the show year, not an episode number.
    let parenYear: number | undefined;
    let lastParenYear: RegExpMatchArray | undefined;
    for (const match of work.matchAll(PAREN_YEAR_RE)) lastParenYear = match;
    if (lastParenYear !== undefined) {
      parenYear = toInt(lastParenYear[1]);
      const at = matchIndex(lastParenYear);
      work = `${work.slice(0, at)} ${work.slice(at + lastParenYear[0].length)}`;
    }

    work = removeJunkParens(removeBrackets(work));

    const context: EpisodeContext = {
      ...(folderSeason !== undefined ? { folderSeason } : {}),
      ...(showInfo !== undefined ? { showInfo } : {}),
      ...(parenYear !== undefined ? { parenYear } : {}),
      ...(releaseGroup !== undefined ? { releaseGroup } : {}),
    };

    const draft =
      matchSxxEyy(work) ??
      matchNxM(work) ??
      (anime ? matchAnime(work, context) : undefined) ??
      matchEpisodeWord(work) ??
      matchLeadingE(work) ??
      matchBareNumber(work, folderSeason);

    if (draft === undefined || draft === 'unknown') {
      return { type: 'unknown', title: bestEffortTitle(base) || bestEffortTitle(fileName) };
    }
    return assembleEpisode(draft, context);
  } catch {
    return { type: 'unknown', title: safeFallbackTitle(relPath) };
  }
}

function parseSeasonDirName(name: string): number | undefined {
  if (SPECIALS_DIR_RE.test(name)) return 0;
  const worded = SEASON_DIR_RE.exec(name);
  if (worded !== null) return toInt(worded[1]);
  const short = SEASON_DIR_SHORT_RE.exec(name);
  if (short !== null) return toInt(short[1]);
  return undefined;
}

function matchSxxEyy(work: string): EpisodeDraft | undefined {
  const match = SXXEYY_RE.exec(work);
  if (match === null) return undefined;
  const season = toInt(match[1]);
  const episode = toInt(match[2]);
  if (season === undefined || episode === undefined) return undefined;

  const draft: EpisodeDraft = {
    episode,
    season,
    prefix: work.slice(0, matchIndex(match)),
    suffix: work.slice(matchIndex(match) + match[0].length),
  };
  const version = toInt(match[3]);
  if (version !== undefined) draft.version = version;

  const continuation = match[4] ?? '';
  let episodeEnd: number | undefined;
  for (const num of continuation.matchAll(/\d{1,3}/g)) {
    const value = toInt(num[0]);
    if (value !== undefined && value > episode) episodeEnd = value;
  }
  if (episodeEnd !== undefined) draft.episodeEnd = episodeEnd;
  return draft;
}

function matchNxM(work: string): EpisodeDraft | undefined {
  const match = NXM_RE.exec(work);
  if (match === null) return undefined;
  const season = toInt(match[1]);
  const episode = toInt(match[2]);
  if (season === undefined || episode === undefined) return undefined;

  let end = matchIndex(match) + match[0].length;
  let episodeEnd: number | undefined;
  const after = work.slice(end);
  const range = NXM_RANGE_TIGHT_RE.exec(after) ?? NXM_RANGE_FULL_RE.exec(after);
  if (range !== null) {
    const value = toInt(range[1]);
    if (value !== undefined && value > episode) {
      episodeEnd = value;
      end += range[0].length;
    }
  }

  const draft: EpisodeDraft = {
    episode,
    season,
    prefix: work.slice(0, matchIndex(match)),
    suffix: work.slice(end),
  };
  if (episodeEnd !== undefined) draft.episodeEnd = episodeEnd;
  return draft;
}

function matchEpisodeWord(work: string): EpisodeDraft | undefined {
  const match = EPISODE_WORD_RE.exec(work);
  if (match === null) return undefined;
  const episode = toInt(match[1]);
  if (episode === undefined) return undefined;
  return {
    episode,
    prefix: work.slice(0, matchIndex(match)),
    suffix: work.slice(matchIndex(match) + match[0].length),
  };
}

function matchLeadingE(work: string): EpisodeDraft | undefined {
  const trimmed = work.trimStart();
  const match = LEADING_E_RE.exec(trimmed);
  if (match === null) return undefined;
  const episode = toInt(match[1]);
  if (episode === undefined) return undefined;
  return { episode, prefix: '', suffix: trimmed.slice(match[0].length) };
}

function matchBareNumber(work: string, folderSeason: number | undefined): EpisodeDraft | undefined {
  if (folderSeason === undefined) return undefined;
  const trimmed = work.trimStart();
  const match = BARE_NUMBER_RE.exec(trimmed);
  if (match === null) return undefined;
  const episode = toInt(match[1]);
  if (episode === undefined) return undefined;
  const draft: EpisodeDraft = {
    episode,
    season: folderSeason,
    prefix: '',
    suffix: trimmed.slice(match[0].length),
  };
  const episodeEnd = toInt(match[2]);
  if (episodeEnd !== undefined && episodeEnd > episode) draft.episodeEnd = episodeEnd;
  return draft;
}

function lastAbsoluteMatch(value: string): RegExpMatchArray | undefined {
  let last: RegExpMatchArray | undefined;
  for (const match of value.matchAll(ABSOLUTE_RE)) last = match;
  return last;
}

/**
 * Anime handling: OVA/NC special markers (season 0), then absolute numbering.
 * Returns 'unknown' to abort parsing (e.g. half episodes like "12.5").
 */
function matchAnime(work: string, context: EpisodeContext): EpisodeDraft | 'unknown' | undefined {
  const marker = SPECIAL_MARKER_RE.exec(work);
  if (marker !== null) {
    let episode = toInt(marker[2]);
    let prefix = work.slice(0, matchIndex(marker));
    const suffix = work.slice(matchIndex(marker) + marker[0].length);
    if (episode === undefined) {
      // "Show - 05 [OVA]" — number precedes the marker.
      const absolute = lastAbsoluteMatch(prefix);
      if (absolute !== undefined && absolute[2] === undefined) {
        episode = toInt(absolute[1]);
        prefix = prefix.slice(0, matchIndex(absolute));
      }
    }
    if (episode === undefined) return 'unknown';
    return { episode, season: 0, prefix, suffix };
  }

  const match = lastAbsoluteMatch(work);
  if (match === undefined) return undefined;
  // Half/recap episodes ("12.5") cannot be mapped — bail out as unknown.
  if (match[2] !== undefined || match[5] !== undefined) return 'unknown';
  const episode = toInt(match[1]);
  if (episode === undefined) return undefined;
  // A dash-separated 19xx/20xx number is a year, not an absolute episode.
  if (episode >= 1900 && episode <= 2099) return 'unknown';

  const draft: EpisodeDraft = {
    episode,
    absolute: true,
    prefix: work.slice(0, matchIndex(match)),
    suffix: work.slice(matchIndex(match) + match[0].length),
  };
  if (context.folderSeason !== undefined) draft.season = context.folderSeason;
  const version = toInt(match[3]);
  if (version !== undefined) draft.version = version;
  const episodeEnd = toInt(match[4]);
  if (episodeEnd !== undefined && episodeEnd > episode) draft.episodeEnd = episodeEnd;
  return draft;
}

function cleanEpisodeTitle(suffix: string): string | undefined {
  let tokens = tokenize(suffix);
  while (
    tokens.length > 0 &&
    (SEPARATOR_TOKEN_RE.test(tokens[0] ?? '') || YEAR_TOKEN_RE.test(tokens[0] ?? ''))
  ) {
    tokens.shift();
  }
  const tagIdx = tokens.findIndex((token) => STRONG_TAG_RE.test(token));
  if (tagIdx >= 0) tokens = tokens.slice(0, tagIdx);
  while (tokens.length > 0 && SEPARATOR_TOKEN_RE.test(tokens.at(-1) ?? '')) tokens.pop();
  const title = tokens.join(' ').trim();
  return title.length > 0 ? title : undefined;
}

function assembleEpisode(draft: EpisodeDraft, context: EpisodeContext): ParsedEpisode {
  let prefix = draft.prefix;
  let season = draft.season;

  // "Show Season 1 Episode 2" — pull the season out of the prefix.
  if (season === undefined) {
    const seasonWord = SEASON_WORD_RE.exec(prefix);
    if (seasonWord !== null) {
      season = toInt(seasonWord[1]);
      prefix =
        prefix.slice(0, matchIndex(seasonWord)) +
        prefix.slice(matchIndex(seasonWord) + seasonWord[0].length);
    }
  }
  // Season folder fills in when the filename itself has no season. When both
  // exist and disagree, the explicit marker in the filename wins.
  if (season === undefined && context.folderSeason !== undefined) {
    season = context.folderSeason;
  }

  const prefixInfo = cleanName(prefix);
  const folderTitle = context.showInfo?.title;
  const showTitle =
    folderTitle !== undefined && folderTitle.length > 0
      ? folderTitle
      : prefixInfo.title.length > 0
        ? prefixInfo.title
        : undefined;
  const year = context.showInfo?.year ?? context.parenYear ?? prefixInfo.year;

  const result: ParsedEpisode = { type: 'episode', episode: draft.episode };
  if (showTitle !== undefined) result.showTitle = showTitle;
  if (season !== undefined) result.season = season;
  if (draft.episodeEnd !== undefined) result.episodeEnd = draft.episodeEnd;
  if (draft.absolute === true) result.absolute = true;
  if (year !== undefined) result.year = year;
  if (draft.version !== undefined) result.version = draft.version;
  if (context.releaseGroup !== undefined) result.releaseGroup = context.releaseGroup;
  const episodeTitle = cleanEpisodeTitle(draft.suffix);
  if (episodeTitle !== undefined) result.episodeTitle = episodeTitle;
  return result;
}

/** Absolute last-resort title for the catch-all paths — must never throw. */
function safeFallbackTitle(relPath: unknown): string {
  try {
    return typeof relPath === 'string' ? bestEffortTitle(relPath.replace(/[\\/]+/g, ' ')) : '';
  } catch {
    return '';
  }
}
