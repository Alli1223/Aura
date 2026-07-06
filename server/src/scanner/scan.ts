import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { MediaItem, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { getPrisma } from '../db/client.js';
import { isPathWithin, validateLibraryPath } from '../lib/media-roots.js';
import {
  dispatchEvent,
  MEDIA_ADDED_EMISSION_CAP,
  type DispatchFn,
} from '../lib/webhooks.js';
import { isVideoFile, probeFile, realVideoStreams, type ProbeResult } from '../media/ffprobe.js';
import { persistProbe } from '../media/persist-probe.js';
import { parseEpisodePath, parseMoviePath } from './filename-parser.js';

// Library filesystem scanner: walks every LibraryPath root of a library,
// discovers video files, probes new/changed ones with ffprobe and maps them
// to MediaItem / MediaFile / MediaStream rows. No metadata enrichment happens
// here — items are created from filename parsing only; metadata agents fill
// them in later.
//
// Stats invariant: every candidate file counted in `filesSeen` lands in
// exactly one of filesAdded / filesUpdated / filesUnchanged / filesSkipped.
// `errors` records per-file failures (probe/db) — those files also count as
// skipped. `filesMissing` counts files transitioned available -> missing by
// the deletion pass and is independent of filesSeen. Individual file
// failures never abort the scan.

/** File extensions considered video candidates (lowercase, no dot). */
export const VIDEO_EXTENSIONS = new Set([
  'mkv',
  'mp4',
  'm4v',
  'avi',
  'mov',
  'wmv',
  'flv',
  'webm',
  'ts',
  'm2ts',
  'mpg',
  'mpeg',
  'ogv',
  '3gp',
]);

/** Number of ffprobe processes run concurrently. */
export const PROBE_CONCURRENCY = 4;

/** "sample"/"trailer" basenames, including "-sample"/".trailer" suffixes. */
const JUNK_BASENAME_RE = /(?:^|[ ._-])(?:sample|trailer)$/i;

/** Leading article to move to the end for sorting: "The X" -> "X, The". */
const SORT_ARTICLE_RE = /^(the|a|an)\s+(.+)$/i;

export interface ScanError {
  path: string;
  message: string;
}

export interface ScanStats {
  /** Candidate video files encountered during the walk (junk included). */
  filesSeen: number;
  /** New MediaFile rows created. */
  filesAdded: number;
  /** Existing rows whose size/mtime changed and were re-probed. */
  filesUpdated: number;
  /** Existing rows matched by path+size+mtime (lastSeenAt refreshed). */
  filesUnchanged: number;
  /** Rows transitioned available -> missing by the deletion pass. */
  filesMissing: number;
  /** Candidates skipped: junk names, zero-byte, unparseable, non-video, errors. */
  filesSkipped: number;
  /** MediaItem rows created (movies, shows, seasons, episodes). */
  itemsCreated: number;
  /** Per-file failures (probe or database); never abort the scan. */
  errors: ScanError[];
}

/** Probe function signature; injectable so tests can count/stall/fake probes. */
export type ProbeFn = (absPath: string) => Promise<ProbeResult>;

/** A newly added/updated video file handed to the trickplay pre-warm hook. */
export interface TrickplayScanFile {
  id: string;
  path: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Best-effort trickplay pre-warm hook, run once per newly added/updated file
 * AFTER the scan's database work completes. Injected by callers that have the
 * server config (so it can honour TRICKPLAY_ENABLED and bound the work); absent
 * in the watcher/scheduler paths, which rely on on-demand generation instead.
 * A rejection is logged and swallowed — a preview must never fail a scan.
 */
export type TrickplayScanHook = (file: TrickplayScanFile) => Promise<void>;

export interface ScanOptions {
  /**
   * Media roots for path containment checks. Defaults to the MEDIA_ROOTS
   * environment variable (routes pass their loaded config explicitly).
   */
  mediaRoots?: readonly string[];
  /** Replaces the real ffprobe call (tests: counting/stalling/fake probes). */
  probe?: ProbeFn;
  /** ffprobe pool size; defaults to PROBE_CONCURRENCY. */
  concurrency?: number;
  /** Called with a stats snapshot as counters change (live progress). */
  onProgress?: (stats: ScanStats) => void;
  /**
   * Event dispatcher for `media.added` webhooks; defaults to the real
   * dispatchEvent. Injectable so tests can assert emission with a spy.
   */
  dispatch?: DispatchFn;
  /**
   * Best-effort trickplay pre-warm, run for each newly added/updated file after
   * the scan's DB work. Defaults to no pre-warm (watcher/scheduler paths and
   * every existing test), so the scan is unchanged unless a caller opts in.
   */
  trickplay?: TrickplayScanHook;
  log?: FastifyBaseLogger;
}

/** "The Matrix" -> "Matrix, The"; titles without an article are unchanged. */
export function toSortTitle(title: string): string {
  const match = SORT_ARTICLE_RE.exec(title.trim());
  const article = match?.[1];
  const rest = match?.[2];
  if (article !== undefined && rest !== undefined) return `${rest}, ${article}`;
  return title.trim();
}

// ---------------------------------------------------------------------------
// Internal plumbing
// ---------------------------------------------------------------------------

interface Candidate {
  /** Absolute path as walked (root is canonical, symlinks are not followed). */
  absPath: string;
  /** Canonical library root this file was found under. */
  root: string;
  size: number;
  mtimeMs: number;
}

/** What a candidate should become, decided by the filename parser. */
type ItemPlan =
  | { kind: 'movie'; title: string; year: number | undefined }
  | {
      kind: 'episode';
      showTitle: string;
      showYear: number | undefined;
      seasonNumber: number;
      episodeNumber: number;
      absoluteEpisodeNumber: number | undefined;
      episodeTitle: string | undefined;
    };

function fallbackMediaRoots(): readonly string[] {
  return (process.env.MEDIA_ROOTS ?? '/media')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}

function snapshot(stats: ScanStats): ScanStats {
  return { ...stats, errors: [...stats.errors] };
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Recursively collects candidate video files under `dir`. Dotfiles and
 * dot-directories are ignored; symlinks are not followed. Junk names
 * (sample/trailer) and zero-byte files count as seen + skipped.
 */
async function walk(
  dir: string,
  root: string,
  candidates: Candidate[],
  stats: ScanStats,
  log?: FastifyBaseLogger,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    stats.errors.push({ path: dir, message: `Failed to read directory: ${message(err)}` });
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(entryPath, root, candidates, stats, log);
      continue;
    }
    if (!entry.isFile()) continue; // symlinks, sockets, devices

    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) continue;
    stats.filesSeen += 1;

    const base = entry.name.slice(0, entry.name.length - ext.length - 1);
    if (JUNK_BASENAME_RE.test(base)) {
      log?.debug({ path: entryPath }, 'scan: skipping sample/trailer file');
      stats.filesSkipped += 1;
      continue;
    }

    let fileStat;
    try {
      fileStat = await stat(entryPath);
    } catch (err) {
      stats.errors.push({ path: entryPath, message: `Failed to stat file: ${message(err)}` });
      stats.filesSkipped += 1;
      continue;
    }
    if (fileStat.size === 0) {
      log?.debug({ path: entryPath }, 'scan: skipping zero-byte file');
      stats.filesSkipped += 1;
      continue;
    }

    candidates.push({
      absPath: entryPath,
      root,
      size: fileStat.size,
      mtimeMs: Math.round(fileStat.mtimeMs),
    });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decides what MediaItem hierarchy a file belongs to, purely from its path.
 * Returns undefined for unparseable files (skip: no garbage rows).
 */
function planItem(
  libraryType: string,
  relPath: string,
  log?: FastifyBaseLogger,
): ItemPlan | undefined {
  if (libraryType === 'tv' || libraryType === 'anime') {
    const parsed = parseEpisodePath(relPath, { anime: libraryType === 'anime' });
    if (parsed.type === 'unknown') {
      log?.warn({ path: relPath }, 'scan: could not identify episode from filename, skipping');
      return undefined;
    }
    // Untitled: derive the show from the top-level folder the file lives in.
    const topFolder = relPath.includes(path.sep) ? relPath.split(path.sep)[0] : undefined;
    const showTitle = parsed.showTitle ?? topFolder;
    if (showTitle === undefined || showTitle.length === 0) {
      log?.warn({ path: relPath }, 'scan: episode has no show title or folder, skipping');
      return undefined;
    }
    return {
      kind: 'episode',
      showTitle,
      showYear: parsed.year,
      // Absolute-numbered files (no season folder/marker) attach to season 1.
      seasonNumber: parsed.season ?? 1,
      episodeNumber: parsed.episode,
      absoluteEpisodeNumber: parsed.absolute === true ? parsed.episode : undefined,
      episodeTitle: parsed.episodeTitle,
    };
  }

  // movies / recordings / other: one movie item per title+year.
  const parsed = parseMoviePath(relPath);
  if (parsed.type === 'unknown' || parsed.title.length === 0) {
    log?.warn({ path: relPath }, 'scan: could not identify movie from filename, skipping');
    return undefined;
  }
  return { kind: 'movie', title: parsed.title, year: parsed.year };
}

/**
 * Find-or-create cache for MediaItems within one scan, so multi-version
 * files and sibling episodes share items without repeated lookups. All
 * writes happen in the serial store phase — no creation races.
 */
class ItemResolver {
  private readonly cache = new Map<string, MediaItem>();

  /**
   * Top-level items (movies/shows) newly CREATED during this scan — the source
   * of `media.added` events. Seasons/episodes are excluded (only the show is a
   * top-level "new media" announcement).
   */
  readonly newTopLevelItems: MediaItem[] = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly libraryId: string,
    private readonly stats: ScanStats,
  ) {}

  private async findOrCreate(
    key: string,
    where: Record<string, unknown>,
    create: () => Promise<MediaItem>,
  ): Promise<MediaItem> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let item = await this.prisma.mediaItem.findFirst({
      where: { libraryId: this.libraryId, ...where },
    });
    if (item === null) {
      item = await create();
      this.stats.itemsCreated += 1;
      if (item.type === 'movie' || item.type === 'show') {
        this.newTopLevelItems.push(item);
      }
    }
    this.cache.set(key, item);
    return item;
  }

  async movie(title: string, year: number | undefined): Promise<MediaItem> {
    return this.findOrCreate(
      `movie ${title} ${year ?? ''}`,
      { type: 'movie', title, year: year ?? null },
      () =>
        this.prisma.mediaItem.create({
          data: {
            libraryId: this.libraryId,
            type: 'movie',
            title,
            sortTitle: toSortTitle(title),
            year: year ?? null,
          },
        }),
    );
  }

  async show(title: string, year: number | undefined): Promise<MediaItem> {
    return this.findOrCreate(`show ${title}`, { type: 'show', title }, () =>
      this.prisma.mediaItem.create({
        data: {
          libraryId: this.libraryId,
          type: 'show',
          title,
          sortTitle: toSortTitle(title),
          year: year ?? null,
        },
      }),
    );
  }

  async season(show: MediaItem, seasonNumber: number): Promise<MediaItem> {
    const title = seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`;
    return this.findOrCreate(
      `season ${show.id} ${seasonNumber}`,
      { type: 'season', parentId: show.id, seasonNumber },
      () =>
        this.prisma.mediaItem.create({
          data: {
            libraryId: this.libraryId,
            type: 'season',
            parentId: show.id,
            title,
            sortTitle: title,
            seasonNumber,
          },
        }),
    );
  }

  async episode(
    season: MediaItem,
    plan: Extract<ItemPlan, { kind: 'episode' }>,
  ): Promise<MediaItem> {
    const title = plan.episodeTitle ?? `Episode ${plan.episodeNumber}`;
    return this.findOrCreate(
      `episode ${season.id} ${plan.episodeNumber}`,
      { type: 'episode', parentId: season.id, episodeNumber: plan.episodeNumber },
      () =>
        this.prisma.mediaItem.create({
          data: {
            libraryId: this.libraryId,
            type: 'episode',
            parentId: season.id,
            title,
            sortTitle: title,
            seasonNumber: plan.seasonNumber,
            episodeNumber: plan.episodeNumber,
            absoluteEpisodeNumber: plan.absoluteEpisodeNumber ?? null,
          },
        }),
    );
  }

  async resolve(plan: ItemPlan): Promise<MediaItem> {
    if (plan.kind === 'movie') return this.movie(plan.title, plan.year);
    const show = await this.show(plan.showTitle, plan.showYear);
    const season = await this.season(show, plan.seasonNumber);
    return this.episode(season, plan);
  }
}

/**
 * Fires one `media.added` event per newly-created top-level item. Flood guard:
 * when a scan created more than MEDIA_ADDED_EMISSION_CAP new items (e.g. a bulk
 * first scan) the whole run's emissions are skipped so subscribers are not
 * hammered — the items are still added, just not announced.
 */
function emitMediaAdded(
  dispatch: DispatchFn,
  libraryId: string,
  items: readonly MediaItem[],
  log?: FastifyBaseLogger,
): void {
  if (items.length === 0) return;
  if (items.length > MEDIA_ADDED_EMISSION_CAP) {
    log?.info(
      { libraryId, count: items.length, cap: MEDIA_ADDED_EMISSION_CAP },
      'scan: too many new items; skipping media.added webhooks for this run',
    );
    return;
  }
  for (const item of items) {
    void dispatch(
      'media.added',
      { itemId: item.id, libraryId, type: item.type, title: item.title },
      { log },
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans one library: walks its roots, creates/updates MediaItem, MediaFile
 * and MediaStream rows and marks files that vanished from disk as missing.
 * Throws only for whole-scan failures (unknown library); per-file problems
 * are recorded in `stats.errors` and the scan carries on.
 */
export async function scanLibrary(libraryId: string, opts: ScanOptions = {}): Promise<ScanStats> {
  const prisma = getPrisma();
  const log = opts.log;
  const probe = opts.probe ?? ((absPath: string) => probeFile(absPath));
  const mediaRoots = opts.mediaRoots ?? fallbackMediaRoots();
  const concurrency = opts.concurrency ?? PROBE_CONCURRENCY;
  const dispatch = opts.dispatch ?? dispatchEvent;

  const library = await prisma.library.findUnique({
    where: { id: libraryId },
    include: { paths: { orderBy: { path: 'asc' } } },
  });
  if (library === null) throw new Error(`Library ${libraryId} not found`);

  const stats: ScanStats = {
    filesSeen: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 0,
    filesMissing: 0,
    filesSkipped: 0,
    itemsCreated: 0,
    errors: [],
  };
  const progress = (): void => opts.onProgress?.(snapshot(stats));

  // Re-validate every root at scan time (it may have vanished or been
  // re-pointed since library creation); walk only the valid ones.
  const validRoots: string[] = [];
  for (const entry of library.paths) {
    try {
      validRoots.push(await validateLibraryPath(entry.path, mediaRoots));
    } catch (err) {
      log?.warn(
        { libraryId, root: entry.path, reason: message(err) },
        'scan: skipping invalid library root',
      );
    }
  }

  // Pre-resolve the media roots once for the per-file containment checks.
  const resolvedMediaRoots: string[] = [];
  for (const root of mediaRoots) {
    try {
      resolvedMediaRoots.push(await realpath(root));
    } catch {
      // Missing root cannot contain anything.
    }
  }

  const candidates: Candidate[] = [];
  for (const root of validRoots) {
    await walk(root, root, candidates, stats, log);
  }
  progress();

  // Change detection against the library's existing rows, by canonical path.
  const existingRows = await prisma.mediaFile.findMany({
    where: { mediaItem: { libraryId } },
  });
  const byPath = new Map(existingRows.map((row) => [row.path, row]));

  const now = new Date();
  const unchangedPaths: string[] = [];
  const toProbe: Candidate[] = [];
  for (const candidate of candidates) {
    const existing = byPath.get(candidate.absPath);
    if (
      existing !== undefined &&
      existing.size === BigInt(candidate.size) &&
      existing.mtimeMs === BigInt(candidate.mtimeMs)
    ) {
      unchangedPaths.push(candidate.absPath);
    } else {
      toProbe.push(candidate);
    }
  }

  if (unchangedPaths.length > 0) {
    // Untouched files: refresh lastSeenAt; restore "missing" -> "available".
    await prisma.mediaFile.updateMany({
      where: { path: { in: unchangedPaths } },
      data: { lastSeenAt: now, status: 'available' },
    });
    stats.filesUnchanged += unchangedPaths.length;
    progress();
  }

  // Parse filenames before probing: files we could never map to an item
  // (parse type "unknown") are skipped without wasting an ffprobe run on
  // every scan. Files that parse but turn out not to be video are handled
  // after the probe.
  const jobs: Array<{ candidate: Candidate; plan: ItemPlan }> = [];
  for (const candidate of toProbe) {
    const relPath = path.relative(candidate.root, candidate.absPath);
    const plan = planItem(library.type, relPath, log);
    if (plan === undefined) {
      stats.filesSkipped += 1;
      continue;
    }
    jobs.push({ candidate, plan });
  }
  progress();

  // Probe new/changed files concurrently; store results serially afterwards
  // so item find-or-create never races with itself.
  const probed = new Map<string, ProbeResult>();
  await runPool(jobs, concurrency, async ({ candidate }) => {
    try {
      probed.set(candidate.absPath, await probe(candidate.absPath));
    } catch (err) {
      stats.errors.push({ path: candidate.absPath, message: message(err) });
      stats.filesSkipped += 1;
      progress();
    }
  });

  const resolver = new ItemResolver(prisma, libraryId, stats);
  const prewarm: TrickplayScanFile[] = [];
  for (const { candidate, plan } of jobs) {
    const result = probed.get(candidate.absPath);
    if (result === undefined) continue; // probe failed; already recorded
    try {
      await storeCandidate(prisma, resolver, candidate, plan, result, {
        stats,
        byPathRow: byPath.get(candidate.absPath),
        resolvedMediaRoots,
        now,
        prewarm,
        log,
      });
    } catch (err) {
      stats.errors.push({ path: candidate.absPath, message: message(err) });
      stats.filesSkipped += 1;
    }
    progress();
  }

  // Announce newly-created top-level items (movies/shows) via media.added
  // webhooks. Fire-and-forget so a slow/broken subscriber never delays or
  // fails the scan.
  emitMediaAdded(dispatch, libraryId, resolver.newTopLevelItems, log);

  // Trickplay pre-warm: generate scrub-preview sprites for the files added this
  // scan, but only when a caller wired the hook (it self-bounds and honours
  // TRICKPLAY_ENABLED). Runs after all DB work, sequentially and best-effort —
  // a preview failure never affects the scan result.
  if (opts.trickplay !== undefined) {
    for (const file of prewarm) {
      try {
        await opts.trickplay(file);
      } catch (err) {
        log?.debug({ path: file.path, err }, 'scan: trickplay pre-warm failed');
      }
    }
  }

  // Deletion pass: rows under the scanned roots that were not seen on disk.
  // Rows are kept (status "missing") so a returning disk restores cleanly;
  // items with zero available files are left for later garbage collection.
  const seenPaths = new Set(candidates.map((candidate) => candidate.absPath));
  for (const row of existingRows) {
    if (seenPaths.has(row.path)) continue;
    if (!validRoots.some((root) => isPathWithin(row.path, root))) continue;
    let stillExists = true;
    try {
      await stat(row.path);
    } catch {
      stillExists = false;
    }
    if (stillExists) continue;
    if (row.status !== 'missing') {
      await prisma.mediaFile.update({ where: { id: row.id }, data: { status: 'missing' } });
      stats.filesMissing += 1;
      log?.info({ path: row.path }, 'scan: file no longer on disk, marked missing');
    }
  }
  progress();

  return stats;
}

interface StoreContext {
  stats: ScanStats;
  byPathRow: { id: string; status: string } | undefined;
  /** Realpath-resolved media roots (missing roots already dropped). */
  resolvedMediaRoots: readonly string[];
  now: Date;
  /** Files added/updated this scan, collected for the trickplay pre-warm pass. */
  prewarm: TrickplayScanFile[];
  log?: FastifyBaseLogger;
}

/** Maps one probed candidate into MediaItem/MediaFile/MediaStream rows. */
async function storeCandidate(
  prisma: PrismaClient,
  resolver: ItemResolver,
  candidate: Candidate,
  plan: ItemPlan,
  probe: ProbeResult,
  ctx: StoreContext,
): Promise<void> {
  const { stats, log } = ctx;

  // Not a real video (audio-only, cover-art-only): never store, and drop any
  // stale row left over from when the path used to be a proper video file.
  if (!isVideoFile(probe)) {
    log?.warn({ path: candidate.absPath }, 'scan: file has no video stream, skipping');
    await prisma.mediaFile.deleteMany({ where: { path: candidate.absPath } });
    stats.filesSkipped += 1;
    return;
  }

  // Defence in depth: only store paths that canonically resolve inside the
  // configured media roots (the walk does not follow symlinks, so this only
  // trips on misconfiguration or TOCTOU shenanigans).
  const canonical = await realpath(candidate.absPath);
  if (!ctx.resolvedMediaRoots.some((root) => isPathWithin(canonical, root))) {
    log?.warn(
      { path: candidate.absPath, canonical },
      'scan: file resolves outside the media roots, skipping',
    );
    stats.filesSkipped += 1;
    return;
  }

  const item = await resolver.resolve(plan);

  let fileId: string;
  if (ctx.byPathRow === undefined) {
    const created = await prisma.mediaFile.create({
      data: {
        mediaItemId: item.id,
        path: candidate.absPath,
        size: BigInt(candidate.size),
        mtimeMs: BigInt(candidate.mtimeMs),
        lastSeenAt: ctx.now,
        status: 'available',
      },
    });
    fileId = created.id;
  } else {
    await prisma.mediaFile.update({
      where: { id: ctx.byPathRow.id },
      data: {
        size: BigInt(candidate.size),
        mtimeMs: BigInt(candidate.mtimeMs),
        lastSeenAt: ctx.now,
        status: 'available',
      },
    });
    fileId = ctx.byPathRow.id;
  }

  await persistProbe(fileId, probe);

  // Count only after the row and its streams are fully persisted, so a file
  // that fails mid-store is recorded as skipped + error, nothing else.
  if (ctx.byPathRow === undefined) stats.filesAdded += 1;
  else stats.filesUpdated += 1;

  // Queue this file for the trickplay pre-warm pass (only if a hook is wired).
  // Dimensions come from the first real video stream, matching persistProbe.
  const video = realVideoStreams(probe)[0];
  ctx.prewarm.push({
    id: fileId,
    path: candidate.absPath,
    width: video?.width ?? null,
    height: video?.height ?? null,
    sizeBytes: candidate.size,
    mtimeMs: candidate.mtimeMs,
  });
}
