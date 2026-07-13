import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma } from '../db/client.js';

// Integration tests for the admin log-viewer routes against a real temporary
// SQLite DB + CONFIG_DIR. The read/download tests drive a hand-written JSONL log
// file (file logging is off under NODE_ENV=test, so nothing competes with the
// controlled content). A separate isolated describe enables real file logging
// to prove redaction reaches the file.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PASSWORD = 'correct-horse-battery';

interface Session {
  id: string;
  accessToken: string;
  role: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface LogEntry {
  time: string | null;
  level: string;
  msg: string;
  [key: string]: unknown;
}

let tempDir: string;
let configDir: string;
let logFile: string;
let app: FastifyInstance;
let admin: Session;
let user: Session;

async function registerUser(): Promise<Session> {
  const username = `user-${randomUUID().slice(0, 18)}`;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string; role: string }; accessToken: string }>();
  return { id: body.user.id, accessToken: body.accessToken, role: body.user.role };
}

/** Serialises a pino-shaped entry to a JSONL line (trailing newline included). */
function jsonl(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

/** Overwrites the active log file with the given raw content. */
async function writeLogFile(content: string): Promise<void> {
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, content);
}

function getLogs(query = '', accessToken?: string) {
  return app.inject({
    method: 'GET',
    url: `/api/logs${query}`,
    headers: accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

function download(accessToken?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/logs/download',
    headers: accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-logs-'));
  configDir = path.join(tempDir, 'config');
  logFile = path.join(configDir, 'logs', 'aura.log');

  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = configDir;
  app = buildApp();
  await app.ready();

  admin = await registerUser(); // first registration => admin
  expect(admin.role).toBe('admin');
  user = await registerUser(); // second => role "user"
  expect(user.role).toBe('user');
}, 120_000);

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('GET /api/logs — auth', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await getLogs()).statusCode).toBe(401);
  });

  it('rejects a non-admin user with 403', async () => {
    const response = await getLogs('', user.accessToken);
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/logs — reading', () => {
  beforeEach(async () => {
    await writeLogFile(
      [
        jsonl({ level: 30, time: 1_700_000_000_000, msg: 'started', reqId: 'r1' }),
        'this is not json\n',
        jsonl({ level: 40, time: 1_700_000_001_000, msg: 'careful' }),
        '{"level":50,"time":\n', // truncated / malformed
        jsonl({ level: 50, time: 1_700_000_002_000, msg: 'boom', code: 'E_OOPS' }),
        jsonl({ level: 20, time: 1_700_000_003_000, msg: 'noisy' }),
      ].join(''),
    );
  });

  it('returns parsed entries (ISO time, level name, msg + fields), malformed lines skipped', async () => {
    const response = await getLogs('', admin.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    const { entries } = response.json<{ entries: LogEntry[] }>();

    // 4 valid lines survive; the 2 malformed ones are skipped.
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.msg)).toEqual(['started', 'careful', 'boom', 'noisy']);

    const first = entries[0]!;
    expect(first.level).toBe('info');
    expect(first.time).toBe(new Date(1_700_000_000_000).toISOString());
    expect(first.reqId).toBe('r1');
    // The internal numeric level is not leaked on the wire.
    expect('levelValue' in first).toBe(false);
    // Extra structured fields ride along.
    expect(entries.find((e) => e.msg === 'boom')?.code).toBe('E_OOPS');
  });

  it('filters to entries at or above the requested level', async () => {
    const response = await getLogs('?level=warn', admin.accessToken);
    expect(response.statusCode).toBe(200);
    const { entries } = response.json<{ entries: LogEntry[] }>();
    expect(entries.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  it('caps the number of returned entries with limit (most recent kept)', async () => {
    const response = await getLogs('?limit=2', admin.accessToken);
    expect(response.statusCode).toBe(200);
    const { entries } = response.json<{ entries: LogEntry[] }>();
    expect(entries.map((e) => e.msg)).toEqual(['boom', 'noisy']);
  });

  it('rejects an invalid level with 400 VALIDATION', async () => {
    const response = await getLogs('?level=loud', admin.accessToken);
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('returns an empty list when the log file is absent', async () => {
    await rm(logFile, { force: true });
    const response = await getLogs('', admin.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ entries: LogEntry[] }>().entries).toEqual([]);
  });
});

describe('GET /api/logs/download', () => {
  it('rejects unauthenticated (401) and non-admin (403)', async () => {
    expect((await download()).statusCode).toBe(401);
    expect((await download(user.accessToken)).statusCode).toBe(403);
  });

  it('returns the raw file as a text attachment', async () => {
    const content = jsonl({ level: 30, time: 1_700_000_000_000, msg: 'downloadable' });
    await writeLogFile(content);

    const response = await download(admin.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(response.headers['content-disposition']).toBe('attachment; filename="aura.log"');
    expect(response.body).toBe(content);
  });

  it('returns an empty attachment when the file is absent', async () => {
    await rm(logFile, { force: true });
    const response = await download(admin.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="aura.log"');
    expect(response.body).toBe('');
  });
});

describe('file logging redaction', () => {
  it('writes a secret field as [REDACTED] to the persisted log file', async () => {
    const redactDir = path.join(tempDir, 'redact-config');
    const redactFile = path.join(redactDir, 'logs', 'aura.log');
    const prevConfigDir = process.env.CONFIG_DIR;
    const prevEnabled = process.env.LOG_FILE_ENABLED;
    process.env.CONFIG_DIR = redactDir;
    process.env.LOG_FILE_ENABLED = 'true';

    // A dedicated app with real file logging on (level below the log call).
    const fileApp = buildApp({ logger: { level: 'info' } });
    await fileApp.ready();
    try {
      fileApp.log.info(
        { body: { password: 'plaintext-secret-value', tmdbApiKey: 'tmdb-secret-key' } },
        'structured log with secrets',
      );
      // appendFileSync is synchronous, but yield a tick to be safe.
      await new Promise((resolve) => setImmediate(resolve));

      const written = readFileSync(redactFile, 'utf8');
      expect(written).toContain('[REDACTED]');
      expect(written).toContain('structured log with secrets');
      expect(written).not.toContain('plaintext-secret-value');
      expect(written).not.toContain('tmdb-secret-key');
    } finally {
      await fileApp.close();
      if (prevConfigDir === undefined) delete process.env.CONFIG_DIR;
      else process.env.CONFIG_DIR = prevConfigDir;
      if (prevEnabled === undefined) delete process.env.LOG_FILE_ENABLED;
      else process.env.LOG_FILE_ENABLED = prevEnabled;
    }
  });
});
