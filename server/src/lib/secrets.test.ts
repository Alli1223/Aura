import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateSecrets, secretsFilePath } from './secrets.js';

// Filesystem-level tests against a fresh temp config dir per test: first-boot
// generation, the jwt-only -> +streamTokenSecret upgrade path, and the
// refuse-to-regenerate policy for corrupt files.

const HEX_256_BITS = /^[0-9a-f]{64}$/;

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'aura-secrets-test-'));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function fileMode(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

async function readSecretsJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(secretsFilePath(configDir), 'utf8')) as Record<string, unknown>;
}

describe('loadOrCreateSecrets on first boot', () => {
  it('creates secrets.json with both independent 256-bit keys, mode 0600', async () => {
    // The config dir itself may not exist yet on first boot.
    const nestedDir = path.join(configDir, 'nested');

    const secrets = loadOrCreateSecrets(nestedDir);

    expect(secrets.jwtSecret).toMatch(HEX_256_BITS);
    expect(secrets.streamTokenSecret).toMatch(HEX_256_BITS);
    // One key must never be derived from (or equal to) the other: leaking a
    // streaming URL must not help forge API credentials.
    expect(secrets.streamTokenSecret).not.toBe(secrets.jwtSecret);

    const file = secretsFilePath(nestedDir);
    expect(await fileMode(file)).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      jwtSecret: secrets.jwtSecret,
      streamTokenSecret: secrets.streamTokenSecret,
    });
  });

  it('returns identical values on subsequent boots without rewriting the file', async () => {
    const first = loadOrCreateSecrets(configDir);
    const raw = await readFile(secretsFilePath(configDir), 'utf8');

    const second = loadOrCreateSecrets(configDir);

    expect(second).toEqual(first);
    expect(await readFile(secretsFilePath(configDir), 'utf8')).toBe(raw);
  });
});

describe('loadOrCreateSecrets upgrade from a jwt-only file', () => {
  const existingJwtSecret = 'f'.repeat(64);

  beforeEach(async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      secretsFilePath(configDir),
      `${JSON.stringify({ jwtSecret: existingJwtSecret }, null, 2)}\n`,
      { mode: 0o600 },
    );
  });

  it('adds streamTokenSecret in place, preserving the existing jwtSecret', async () => {
    const secrets = loadOrCreateSecrets(configDir);

    // The pre-existing JWT secret survives byte for byte (regenerating it
    // would log out every session on upgrade).
    expect(secrets.jwtSecret).toBe(existingJwtSecret);
    expect(secrets.streamTokenSecret).toMatch(HEX_256_BITS);

    expect(await readSecretsJson()).toEqual({
      jwtSecret: existingJwtSecret,
      streamTokenSecret: secrets.streamTokenSecret,
    });
    expect(await fileMode(secretsFilePath(configDir))).toBe(0o600);
  });

  it('persists the upgraded key: the next boot reads it back unchanged', async () => {
    const upgraded = loadOrCreateSecrets(configDir);
    const next = loadOrCreateSecrets(configDir);

    expect(next).toEqual(upgraded);
  });

  it('preserves unrecognised keys in the file across the upgrade', async () => {
    await writeFile(
      secretsFilePath(configDir),
      JSON.stringify({ jwtSecret: existingJwtSecret, futureSecret: 'keep-me' }),
      { mode: 0o600 },
    );

    loadOrCreateSecrets(configDir);

    expect(await readSecretsJson()).toMatchObject({
      jwtSecret: existingJwtSecret,
      futureSecret: 'keep-me',
    });
  });
});

describe('loadOrCreateSecrets with a corrupt file', () => {
  it.each([
    ['an empty object', '{}'],
    ['a malformed jwtSecret', JSON.stringify({ jwtSecret: 'too-short' })],
    ['a non-object', '"just a string"'],
    ['invalid JSON', 'not json'],
  ])('refuses to regenerate over %s', async (_label, contents) => {
    await mkdir(configDir, { recursive: true });
    await writeFile(secretsFilePath(configDir), contents);

    expect(() => loadOrCreateSecrets(configDir)).toThrow();
    // The corrupt file was left untouched for the operator to inspect.
    expect(await readFile(secretsFilePath(configDir), 'utf8')).toBe(contents);
  });

  it('refuses to regenerate a present-but-malformed streamTokenSecret', async () => {
    await mkdir(configDir, { recursive: true });
    const contents = JSON.stringify({ jwtSecret: 'f'.repeat(64), streamTokenSecret: 'short' });
    await writeFile(secretsFilePath(configDir), contents);

    expect(() => loadOrCreateSecrets(configDir)).toThrow(/streamTokenSecret/);
    expect(await readFile(secretsFilePath(configDir), 'utf8')).toBe(contents);
  });
});
