import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SUBTITLE_SUBDIR, sweepTranscodeDir } from './transcode-cleanup.js';

const HOUR = 60 * 60 * 1000;

let transcodeDir: string;

/** Creates <parent>/<name> with a child file, both stamped at `mtimeMs`. */
async function makeDir(parent: string, name: string, mtimeMs: number): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'data'), 'x');
  const when = new Date(mtimeMs);
  await utimes(path.join(dir, 'data'), when, when);
  await utimes(dir, when, when); // stamp the dir last (writes bump its mtime)
  return dir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  transcodeDir = await mkdtemp(path.join(tmpdir(), 'aura-transcode-sweep-'));
});

afterEach(async () => {
  await rm(transcodeDir, { recursive: true, force: true });
});

describe('sweepTranscodeDir', () => {
  it('removes old orphan session dirs and keeps fresh/live ones', async () => {
    const now = Date.now();
    const old = now - 2 * HOUR;
    const fresh = now - 60_000;

    await makeDir(transcodeDir, 'orphan-session', old);
    await makeDir(transcodeDir, 'fresh-session', fresh);
    await makeDir(transcodeDir, 'live-session', old); // old, but protected

    const result = await sweepTranscodeDir({
      transcodeDir,
      maxAgeMs: HOUR,
      now,
      isLive: (name) => name === 'live-session',
    });

    expect(await exists(path.join(transcodeDir, 'orphan-session'))).toBe(false);
    expect(await exists(path.join(transcodeDir, 'fresh-session'))).toBe(true);
    expect(await exists(path.join(transcodeDir, 'live-session'))).toBe(true);
    expect(result.removed).toEqual(['orphan-session']);
    expect(result.kept).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  it('prunes old subtitle cache entries and keeps fresh ones', async () => {
    const now = Date.now();
    const subtitles = path.join(transcodeDir, SUBTITLE_SUBDIR);
    await mkdir(subtitles, { recursive: true });
    await makeDir(subtitles, 'file-old', now - 3 * HOUR);
    await makeDir(subtitles, 'file-new', now - 5 * 60_000);

    const result = await sweepTranscodeDir({ transcodeDir, maxAgeMs: HOUR, now });

    expect(await exists(path.join(subtitles, 'file-old'))).toBe(false);
    expect(await exists(path.join(subtitles, 'file-new'))).toBe(true);
    expect(result.removed).toEqual([path.join(SUBTITLE_SUBDIR, 'file-old')]);
  });

  it('returns an empty result when the transcode dir does not exist', async () => {
    const missing = path.join(transcodeDir, 'nope');
    const result = await sweepTranscodeDir({
      transcodeDir: missing,
      maxAgeMs: HOUR,
      now: Date.now(),
    });
    expect(result).toEqual({ removed: [], freedBytes: 0, kept: 0 });
  });
});
