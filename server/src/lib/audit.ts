import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

export interface AuditEntry {
  /** Dotted event name, e.g. "auth.login.success". */
  action: string;
  userId?: string | null;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  /** JSON-encoded into AuditLog.details. Never put secrets/passwords here. */
  details?: Record<string, unknown>;
}

/**
 * Writes an audit log row. Failures are logged and swallowed so an audit
 * hiccup can never break the request that triggered it.
 */
export async function writeAuditLog(
  prisma: PrismaClient,
  entry: AuditEntry,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        ip: entry.ip ?? null,
        details: entry.details !== undefined ? JSON.stringify(entry.details) : null,
      },
    });
  } catch (err) {
    log?.error({ err, action: entry.action }, 'failed to write audit log entry');
  }
}
