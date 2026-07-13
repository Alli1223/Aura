import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogFileStream, parseLogLine, readRecentLogs } from './log-file.js';

let dir: string;
let logFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'aura-logfile-'));
  logFile = path.join(dir, 'logs', 'aura.log');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Serialises a pino-shaped entry to a JSONL line. */
function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

describe('parseLogLine', () => {
  it('normalises level (number → name) and time (epoch → ISO)', () => {
    const entry = parseLogLine(
      JSON.stringify({ level: 40, time: 1_700_000_000_000, msg: 'careful', reqId: 'abc' }),
    );
    expect(entry).not.toBeNull();
    expect(entry?.level).toBe('warn');
    expect(entry?.levelValue).toBe(40);
    expect(entry?.msg).toBe('careful');
    expect(entry?.time).toBe(new Date(1_700_000_000_000).toISOString());
    // Extra structured fields ride along; pid/hostname are dropped as noise.
    expect(entry?.reqId).toBe('abc');
  });

  it('returns null for malformed / non-object lines', () => {
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('not json')).toBeNull();
    expect(parseLogLine('{"partial":')).toBeNull();
    expect(parseLogLine('42')).toBeNull();
    expect(parseLogLine('null')).toBeNull();
  });
});

describe('readRecentLogs', () => {
  beforeEach(() => {
    createLogFileStream({ filePath: logFile, maxBytes: 1_000_000 }); // creates the dir
    writeFileSync(
      logFile,
      [
        line({ level: 30, time: 1, msg: 'one' }),
        'garbage-not-json\n',
        line({ level: 50, time: 2, msg: 'two' }),
        line({ level: 20, time: 3, msg: 'three' }),
        line({ level: 40, time: 4, msg: 'four' }),
      ].join(''),
    );
  });

  it('skips malformed lines and returns entries oldest→newest', () => {
    const entries = readRecentLogs({ filePath: logFile, limit: 100, maxLines: 100 });
    expect(entries.map((e) => e.msg)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('filters to level >= the requested severity', () => {
    const entries = readRecentLogs({
      filePath: logFile,
      minLevel: 'warn',
      limit: 100,
      maxLines: 100,
    });
    expect(entries.map((e) => e.level)).toEqual(['error', 'warn']);
  });

  it('caps to the most-recent `limit` entries', () => {
    const entries = readRecentLogs({ filePath: logFile, limit: 2, maxLines: 100 });
    expect(entries.map((e) => e.msg)).toEqual(['three', 'four']);
  });

  it('returns [] when the file does not exist', () => {
    expect(readRecentLogs({ filePath: path.join(dir, 'nope.log'), limit: 10, maxLines: 10 })).toEqual(
      [],
    );
  });
});

describe('createLogFileStream rotation', () => {
  it('rotates to <file>.1 once maxBytes is exceeded, bounding disk use', () => {
    const stream = createLogFileStream({ filePath: logFile, maxBytes: 200 });
    const backup = `${logFile}.1`;

    // Each line is ~40 bytes; write enough to force at least one rotation.
    for (let i = 0; i < 20; i += 1) {
      stream.write(line({ level: 30, time: i, msg: `entry-${i}` }));
    }

    expect(existsSync(logFile)).toBe(true);
    expect(existsSync(backup)).toBe(true);
    // The active file stays under (a small multiple of) the cap, not unbounded.
    const activeLines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(activeLines.length).toBeLessThan(20);

    // The most-recent entry is always in the active file.
    const all = readRecentLogs({ filePath: logFile, limit: 100, maxLines: 100 });
    expect(all.at(-1)?.msg).toBe('entry-19');
  });
});
