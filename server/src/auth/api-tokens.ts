import { createHash, randomBytes } from 'node:crypto';

import type { ApiToken, PrismaClient, User } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { API_TOKEN_SCOPES, type ApiTokenScope } from '../db/constants.js';

// Personal API tokens for third-party clients/scripts.
//
// A raw token looks like `aura_<base64url(32 random bytes)>`. The raw value is
// returned to the caller EXACTLY ONCE, at creation; the database only ever
// stores its sha256 hash (unique) plus a short display prefix. This mirrors
// the refresh-token model (auth/refresh.ts): a leak of the database never
// yields a usable credential.
//
// Verification is a single indexed lookup by hash. A token authenticates only
// while it is neither revoked nor expired; the owning user's enabled/password
// state is (re)checked by the authenticate preHandler, not here.

/** Every raw API token carries this prefix; used to route auth + reject junk. */
export const API_TOKEN_PREFIX = 'aura_';

/** Random bytes behind the prefix (256 bits of entropy, like refresh tokens). */
const API_TOKEN_RANDOM_BYTES = 32;

/**
 * Number of leading characters of the raw token stored (and shown) as the
 * display prefix — `aura_` (5) plus a few random characters. Enough to tell
 * two tokens apart in a listing, far too little to authenticate with.
 */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = 12;

/** True when a value has the API-token shape (does not prove validity). */
export function isApiToken(value: string): boolean {
  return value.startsWith(API_TOKEN_PREFIX);
}

/** Generates a new raw API token. Only its hash + prefix are ever persisted. */
export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(API_TOKEN_RANDOM_BYTES).toString('base64url')}`;
}

/** sha256 (hex) of a raw token — the value stored in ApiToken.tokenHash. */
export function hashApiToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export interface CreateApiTokenInput {
  userId: string;
  name: string;
  scope: ApiTokenScope;
  /** Optional absolute expiry; null/undefined means the token never expires. */
  expiresAt?: Date | null;
}

export interface CreatedApiToken {
  /** The persisted metadata row (never contains the raw token). */
  record: ApiToken;
  /** The raw token — return it to the caller once, then never again. */
  rawToken: string;
}

/**
 * Creates and persists a new API token, returning the stored metadata plus the
 * raw token (which the caller must surface exactly once).
 */
export async function createApiToken(
  prisma: PrismaClient,
  input: CreateApiTokenInput,
): Promise<CreatedApiToken> {
  const rawToken = generateApiToken();
  const record = await prisma.apiToken.create({
    data: {
      userId: input.userId,
      name: input.name,
      tokenHash: hashApiToken(rawToken),
      prefix: rawToken.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
      scope: input.scope,
      expiresAt: input.expiresAt ?? null,
    },
  });
  return { record, rawToken };
}

export interface VerifiedApiToken {
  user: User;
  scope: ApiTokenScope;
  /** Id of the matched ApiToken row (used to update lastUsedAt). */
  tokenId: string;
}

/**
 * Verifies a raw API token. Returns the owning user + scope, or null when the
 * value is not an API token, is unknown, is revoked, is expired, or carries an
 * unrecognised scope (fail closed). Never throws. Enabled/password checks are
 * the caller's responsibility (see authenticate).
 */
export async function verifyApiToken(
  prisma: PrismaClient,
  rawToken: string,
  now: number = Date.now(),
): Promise<VerifiedApiToken | null> {
  if (!isApiToken(rawToken)) return null;

  const token = await prisma.apiToken.findUnique({
    where: { tokenHash: hashApiToken(rawToken) },
    include: { user: true },
  });
  if (token === null) return null;
  if (token.revokedAt !== null) return null;
  if (token.expiresAt !== null && token.expiresAt.getTime() <= now) return null;

  const scope = API_TOKEN_SCOPES.find((value) => value === token.scope);
  if (scope === undefined) return null;

  return { user: token.user, scope, tokenId: token.id };
}

/**
 * Best-effort, fire-and-forget update of a token's lastUsedAt. Deliberately
 * NOT awaited by callers and never allowed to throw — a slow or failed write
 * (e.g. the token was revoked between verify and update) must never affect the
 * request it belongs to.
 */
export function touchApiTokenLastUsed(
  prisma: PrismaClient,
  tokenId: string,
  log?: FastifyBaseLogger,
): void {
  void prisma.apiToken
    .update({ where: { id: tokenId }, data: { lastUsedAt: new Date() } })
    .catch((err: unknown) => {
      log?.warn({ err, tokenId }, 'failed to update api token lastUsedAt');
    });
}
