import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, RefreshSession } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const REFRESH_COOKIE_NAME = 'aura_refresh';
/** Scope the cookie to the auth endpoints; nothing else ever sees it. */
export const REFRESH_COOKIE_PATH = '/api/auth';
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Thrown when a rotation loses the race because the session was already rotated. */
export class RefreshTokenReuseError extends Error {
  constructor() {
    super('Refresh session already rotated or revoked');
    this.name = 'RefreshTokenReuseError';
  }
}

/** 256-bit random opaque token. Only its sha256 hash is ever stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function clientMeta(request: FastifyRequest): { userAgent: string | null; ip: string } {
  return { userAgent: request.headers['user-agent'] ?? null, ip: request.ip };
}

/** Creates a new refresh session for a login/registration and returns the raw token. */
export async function createRefreshSession(
  prisma: PrismaClient,
  userId: string,
  request: FastifyRequest,
): Promise<string> {
  const token = generateRefreshToken();
  await prisma.refreshSession.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      ...clientMeta(request),
    },
  });
  return token;
}

/**
 * Rotates a refresh session: creates the successor and revokes the presented
 * session, linking it via replacedById. Throws RefreshTokenReuseError if the
 * session was concurrently rotated/revoked (treat as reuse).
 */
export async function rotateRefreshSession(
  prisma: PrismaClient,
  session: RefreshSession,
  request: FastifyRequest,
): Promise<string> {
  const token = generateRefreshToken();
  await prisma.$transaction(async (tx) => {
    const next = await tx.refreshSession.create({
      data: {
        userId: session.userId,
        tokenHash: hashRefreshToken(token),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        ...clientMeta(request),
      },
    });
    const updated = await tx.refreshSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date(), replacedById: next.id },
    });
    if (updated.count === 0) throw new RefreshTokenReuseError();
  });
  return token;
}

/**
 * Reuse detection response: revokes the whole descendant chain of a session
 * (follow replacedById links) so a stolen-then-rotated token family dies.
 */
export async function revokeSessionChain(prisma: PrismaClient, sessionId: string): Promise<void> {
  const now = new Date();
  const seen = new Set<string>();
  let currentId: string | null = sessionId;
  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const session: RefreshSession | null = await prisma.refreshSession.findUnique({
      where: { id: currentId },
    });
    if (session === null) return;
    if (session.revokedAt === null) {
      await prisma.refreshSession.update({
        where: { id: session.id },
        data: { revokedAt: now },
      });
    }
    currentId = session.replacedById;
  }
}

export function setRefreshCookie(reply: FastifyReply, token: string, secure: boolean): void {
  void reply.setCookie(REFRESH_COOKIE_NAME, token, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  });
}

export function clearRefreshCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'strict',
    secure,
  });
}
