import { createHmac, timingSafeEqual } from 'node:crypto';

import { DEFAULT_STREAM_TOKEN_TTL_MS } from '../config.js';

// Short-lived signed streaming tokens.
//
// `<video>` elements and HLS players fetch media by URL and cannot attach an
// Authorization header, so streaming requests authenticate with a compact
// signed token carried in the URL instead of a JWT. A token scopes exactly
// one user to exactly one media file and expires quickly.
//
// Format: `base64url(payloadJson) + '.' + base64url(hmacSha256(base64urlPayload))`
// with payload `{ u: userId, f: mediaFileId, exp: epochMs }`, signed with the
// dedicated streamTokenSecret from secrets.json (deliberately NOT the JWT
// secret: a leaked streaming URL must never help forge API credentials).
//
// STATELESSNESS CONTRACT (read before consuming): tokens are not stored and
// cannot be revoked individually. Verification proves only that this server
// granted this user access to this file at issue time. Consumers (the
// direct-play and HLS routes) MUST re-check the user's library access at use
// time — grants revoked or users disabled after issuance must be enforced
// there. The short TTL (default 6h) bounds the exposure window after events
// that cannot be re-checked statelessly, e.g. password changes.

/** Claims carried by a verified streaming token. */
export interface StreamTokenClaims {
  userId: string;
  mediaFileId: string;
  expiresAt: Date;
}

/** Why verification rejected a token. */
export type StreamTokenFailure = 'malformed' | 'bad_signature' | 'expired';

/** Discriminated verification result — verifyStreamToken never throws. */
export type StreamTokenVerification =
  | { ok: true; claims: StreamTokenClaims }
  | { ok: false; reason: StreamTokenFailure };

export interface IssueStreamTokenOptions {
  userId: string;
  mediaFileId: string;
  /** The streamTokenSecret from secrets.json. */
  secret: string;
  /** Token lifetime; defaults to DEFAULT_STREAM_TOKEN_TTL_MS (6 hours). */
  ttlMs?: number;
}

/** Compact wire payload. Short keys keep the URL token small. */
interface StreamTokenPayload {
  u: string;
  f: string;
  exp: number;
}

/** Signature half must decode to exactly one HMAC-SHA256 digest. */
const SIGNATURE_BYTES = 32;

/**
 * Both token halves must be non-empty base64url. Checked before decoding
 * because Node's base64url decoder silently skips invalid characters, which
 * would let many byte strings alias the same token.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function hmac(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

/**
 * Issues a signed streaming token for one user + one media file. The caller
 * is responsible for having checked library access first (the token route
 * does). Returns the compact URL-safe token plus its expiry for responses.
 */
export function issueStreamToken({
  userId,
  mediaFileId,
  secret,
  ttlMs = DEFAULT_STREAM_TOKEN_TTL_MS,
}: IssueStreamTokenOptions): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + ttlMs);
  const payload: StreamTokenPayload = { u: userId, f: mediaFileId, exp: expiresAt.getTime() };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = hmac(encodedPayload, secret).toString('base64url');
  return { token: `${encodedPayload}.${signature}`, expiresAt };
}

function parsePayload(encodedPayload: string): StreamTokenPayload | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof decoded !== 'object' || decoded === null) return undefined;
  const record = decoded as Record<string, unknown>;
  const { u, f, exp } = record;
  if (typeof u !== 'string' || u.length === 0) return undefined;
  if (typeof f !== 'string' || f.length === 0) return undefined;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
  return { u, f, exp };
}

/**
 * Verifies a streaming token. Never throws: every failure maps to a typed
 * reason. The signature is checked (in constant time) before the payload is
 * even parsed, so nothing about an unsigned token's content is ever acted on.
 */
export function verifyStreamToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): StreamTokenVerification {
  const parts = token.split('.');
  const [encodedPayload, encodedSignature] = parts;
  if (parts.length !== 2 || encodedPayload === undefined || encodedSignature === undefined) {
    return { ok: false, reason: 'malformed' };
  }
  if (!BASE64URL_PATTERN.test(encodedPayload) || !BASE64URL_PATTERN.test(encodedSignature)) {
    return { ok: false, reason: 'malformed' };
  }

  const provided = Buffer.from(encodedSignature, 'base64url');
  if (provided.length !== SIGNATURE_BYTES) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(provided, hmac(encodedPayload, secret))) {
    return { ok: false, reason: 'bad_signature' };
  }

  const payload = parsePayload(encodedPayload);
  if (payload === undefined) return { ok: false, reason: 'malformed' };
  if (payload.exp <= now) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: { userId: payload.u, mediaFileId: payload.f, expiresAt: new Date(payload.exp) },
  };
}
