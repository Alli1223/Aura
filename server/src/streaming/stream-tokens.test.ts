import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { DEFAULT_STREAM_TOKEN_TTL_MS } from '../config.js';
import { issueStreamToken, verifyStreamToken } from './stream-tokens.js';

// Pure unit tests: the module takes the secret explicitly, so nothing here
// touches the filesystem, the database or process.env.

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);

const USER_ID = 'user-cuid-000000000000001';
const FILE_ID = 'file-cuid-000000000000001';

function issue(overrides: { userId?: string; mediaFileId?: string; ttlMs?: number } = {}) {
  return issueStreamToken({
    userId: overrides.userId ?? USER_ID,
    mediaFileId: overrides.mediaFileId ?? FILE_ID,
    ttlMs: overrides.ttlMs,
    secret: SECRET,
  });
}

/** Builds a correctly signed token around an arbitrary payload string. */
function signRaw(payloadJson: string, secret = SECRET): string {
  const encoded = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Flips the top bit of the base64url character at `index`. Using the TOP bit
 * matters: base64url discards unused LOW bits of the final character, so a
 * low-bit flip there can decode to identical bytes and would not be a
 * tampering at all.
 */
function flipChar(value: string, index: number): string {
  const replacement = B64URL_ALPHABET[B64URL_ALPHABET.indexOf(value[index]!) ^ 0b100000];
  return value.slice(0, index) + replacement! + value.slice(index + 1);
}

describe('issueStreamToken', () => {
  it('produces a compact URL-safe two-part token', () => {
    const { token } = issue();
    // The whole token must survive a URL untouched: only base64url chars
    // and the separating dot, so no percent-encoding can alter it.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('defaults the TTL to DEFAULT_STREAM_TOKEN_TTL_MS (6 hours)', () => {
    const before = Date.now();
    const { expiresAt } = issue();
    const after = Date.now();
    expect(DEFAULT_STREAM_TOKEN_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_STREAM_TOKEN_TTL_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + DEFAULT_STREAM_TOKEN_TTL_MS);
  });

  it('round-trips through verifyStreamToken with the same claims', () => {
    const { token, expiresAt } = issue();

    const result = verifyStreamToken(token, SECRET);

    expect(result).toEqual({
      ok: true,
      claims: { userId: USER_ID, mediaFileId: FILE_ID, expiresAt },
    });
  });
});

describe('verifyStreamToken', () => {
  it('rejects an expired token', async () => {
    const { token } = issue({ ttlMs: 1 });
    await sleep(10);

    expect(verifyStreamToken(token, SECRET)).toEqual({ ok: false, reason: 'expired' });
  });

  it('treats a token as expired exactly at its expiry instant, valid just before', () => {
    const { token, expiresAt } = issue();
    expect(verifyStreamToken(token, SECRET, expiresAt.getTime() - 1).ok).toBe(true);
    expect(verifyStreamToken(token, SECRET, expiresAt.getTime())).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a token whose payload half was tampered with', () => {
    const { token } = issue();
    const [payload, signature] = token.split('.') as [string, string];

    for (const index of [0, Math.floor(payload.length / 2), payload.length - 1]) {
      const tampered = `${flipChar(payload, index)}.${signature}`;
      expect(verifyStreamToken(tampered, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  it('rejects a token whose signature half was tampered with', () => {
    const { token } = issue();
    const [payload, signature] = token.split('.') as [string, string];

    for (const index of [0, Math.floor(signature.length / 2), signature.length - 1]) {
      const tampered = `${payload}.${flipChar(signature, index)}`;
      expect(verifyStreamToken(tampered, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issueStreamToken({ userId: USER_ID, mediaFileId: FILE_ID, secret: SECRET });

    expect(verifyStreamToken(token, OTHER_SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a valid payload paired with the signature of another token', () => {
    const { token: tokenA } = issue();
    const { token: tokenB } = issue({ mediaFileId: 'file-cuid-000000000000002' });
    const spliced = `${tokenA.split('.')[0]}.${tokenB.split('.')[1]}`;

    expect(verifyStreamToken(spliced, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['an empty string', ''],
    ['a string with no dot', 'abcdef'],
    ['an empty payload half', '.abcdef'],
    ['an empty signature half', 'abcdef.'],
    ['too many parts', 'aa.bb.cc'],
    ['non-base64url payload characters', '!!!.abcdef'],
    ['non-base64url signature characters', 'abcdef.%%%'],
    ['a JWT-looking string', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig~with~junk'],
  ])('rejects %s as malformed without throwing', (_label, value) => {
    expect(verifyStreamToken(value, SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['non-JSON', 'not json at all'],
    ['a JSON scalar', '42'],
    ['JSON null', 'null'],
    ['a JSON array', '[1,2,3]'],
    ['a missing user id', `{"f":"${FILE_ID}","exp":${Date.now() + 60_000}}`],
    ['an empty user id', `{"u":"","f":"${FILE_ID}","exp":${Date.now() + 60_000}}`],
    ['a missing file id', `{"u":"${USER_ID}","exp":${Date.now() + 60_000}}`],
    ['a non-numeric exp', `{"u":"${USER_ID}","f":"${FILE_ID}","exp":"soon"}`],
    ['a missing exp', `{"u":"${USER_ID}","f":"${FILE_ID}"}`],
  ])('rejects a correctly signed payload containing %s as malformed', (_label, payloadJson) => {
    // Signature is valid, so these exercise the payload validation itself.
    expect(verifyStreamToken(signRaw(payloadJson), SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a signature half that decodes to the wrong number of bytes', () => {
    const [payload] = issue().token.split('.');
    const short = Buffer.from('too short', 'utf8').toString('base64url');

    expect(verifyStreamToken(`${payload}.${short}`, SECRET)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('keeps claims bound to the issuing user and file (not interchangeable)', () => {
    const issued = [
      issue({ userId: 'user-a', mediaFileId: 'file-1' }),
      issue({ userId: 'user-a', mediaFileId: 'file-2' }),
      issue({ userId: 'user-b', mediaFileId: 'file-1' }),
    ];
    const tokens = issued.map(({ token }) => token);
    expect(new Set(tokens).size).toBe(tokens.length);

    const claims = tokens.map((token) => {
      const result = verifyStreamToken(token, SECRET);
      if (!result.ok) throw new Error(`expected token to verify, got ${result.reason}`);
      return result.claims;
    });
    expect(claims.map(({ userId, mediaFileId }) => ({ userId, mediaFileId }))).toEqual([
      { userId: 'user-a', mediaFileId: 'file-1' },
      { userId: 'user-a', mediaFileId: 'file-2' },
      { userId: 'user-b', mediaFileId: 'file-1' },
    ]);
  });
});
