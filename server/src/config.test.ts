import { describe, expect, it } from 'vitest';

import { DEFAULT_STREAM_TOKEN_TTL_MS, loadConfig } from './config.js';

// Pure unit tests: loadConfig is given explicit env objects, so nothing here
// depends on (or mutates) the real process environment.

describe('loadConfig hardening options', () => {
  it('defaults to hardened values', () => {
    const config = loadConfig({});

    expect(config.TRUST_PROXY).toBe(false);
    expect(config.CORS_ORIGINS).toEqual([]);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.RATE_LIMIT_MAX).toBe(300);
    expect(config.RATE_LIMIT_AUTH_MAX).toBe(10);
    expect(config.RATE_LIMIT_REFRESH_MAX).toBe(30);
    expect(config.LOG_LEVEL).toBe('info');
    // Credential routes are strictest, refresh next, global most generous.
    expect(config.RATE_LIMIT_AUTH_MAX).toBeLessThan(config.RATE_LIMIT_REFRESH_MAX);
    expect(config.RATE_LIMIT_REFRESH_MAX).toBeLessThan(config.RATE_LIMIT_MAX);
  });

  it('under NODE_ENV=test disables rate limiting and quietens logs by default', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config.RATE_LIMIT_ENABLED).toBe(false);
    expect(config.LOG_LEVEL).toBe('warn');
  });

  it('lets explicit values override the test defaults', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      RATE_LIMIT_ENABLED: 'true',
      LOG_LEVEL: 'debug',
      RATE_LIMIT_MAX: '42',
    });

    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.RATE_LIMIT_MAX).toBe(42);
  });

  it('parses TRUST_PROXY as a boolean string', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false);
    expect(() => loadConfig({ TRUST_PROXY: 'maybe' })).toThrow(/Invalid environment/);
  });

  it('parses CORS_ORIGINS as a comma-separated origin list', () => {
    const config = loadConfig({
      CORS_ORIGINS: ' https://app.example.com , http://other.example.com:8080/ ',
    });

    expect(config.CORS_ORIGINS).toEqual([
      'https://app.example.com',
      'http://other.example.com:8080',
    ]);
  });

  it.each([
    ['not a URL', 'not-a-url'],
    ['a path', 'https://app.example.com/admin'],
    ['a non-http scheme', 'ftp://files.example.com'],
    ['a wildcard', '*'],
  ])('rejects CORS_ORIGINS containing %s', (_label, value) => {
    expect(() => loadConfig({ CORS_ORIGINS: value })).toThrow(/Invalid environment/);
  });

  it('rejects invalid LOG_LEVEL and rate limit values', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/Invalid environment/);
    expect(() => loadConfig({ RATE_LIMIT_MAX: '0' })).toThrow(/Invalid environment/);
    expect(() => loadConfig({ RATE_LIMIT_AUTH_MAX: 'lots' })).toThrow(/Invalid environment/);
  });
});

describe('loadConfig STREAM_TOKEN_TTL_MS', () => {
  it('defaults to six hours', () => {
    expect(loadConfig({}).STREAM_TOKEN_TTL_MS).toBe(DEFAULT_STREAM_TOKEN_TTL_MS);
    expect(DEFAULT_STREAM_TOKEN_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('accepts an explicit override in milliseconds', () => {
    expect(loadConfig({ STREAM_TOKEN_TTL_MS: '60000' }).STREAM_TOKEN_TTL_MS).toBe(60_000);
  });

  it.each([
    ['a non-number', 'soon'],
    ['zero', '0'],
    ['a negative value', '-1'],
    ['a sub-second value', '999'],
    ['a fraction', '60000.5'],
    ['more than seven days', String(8 * 24 * 60 * 60 * 1000)],
  ])('rejects %s', (_label, value) => {
    expect(() => loadConfig({ STREAM_TOKEN_TTL_MS: value })).toThrow(/Invalid environment/);
  });
});

describe('loadConfig MEDIA_ROOTS', () => {
  it('defaults to /media', () => {
    expect(loadConfig({}).MEDIA_ROOTS).toEqual(['/media']);
  });

  it('parses a comma-separated list, normalising and de-duplicating entries', () => {
    const config = loadConfig({
      MEDIA_ROOTS: ' /media , /mnt/storage/ , /media/../media , /mnt//storage ',
    });

    expect(config.MEDIA_ROOTS).toEqual(['/media', '/mnt/storage']);
  });

  it('rejects relative entries and empty lists', () => {
    expect(() => loadConfig({ MEDIA_ROOTS: 'media' })).toThrow(/Invalid environment/);
    expect(() => loadConfig({ MEDIA_ROOTS: '/media,relative/path' })).toThrow(
      /Invalid environment/,
    );
    expect(() => loadConfig({ MEDIA_ROOTS: '' })).toThrow(/Invalid environment/);
    expect(() => loadConfig({ MEDIA_ROOTS: ' , ' })).toThrow(/Invalid environment/);
  });
});
