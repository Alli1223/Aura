import type { FastifyReply } from 'fastify';
import type { ZodType } from 'zod';

import { sendError } from './errors.js';

/**
 * Validates a request body against a zod schema. On failure sends a
 * 400 VALIDATION error (first issue message) and returns undefined;
 * callers must bail out when that happens.
 */
export function parseBody<T>(
  schema: ZodType<T>,
  body: unknown,
  reply: FastifyReply,
): T | undefined {
  const result = schema.safeParse(body);
  if (!result.success) {
    sendError(reply, 400, 'VALIDATION', result.error.issues[0]?.message ?? 'Invalid request body');
    return undefined;
  }
  return result.data;
}

/**
 * Validates request path parameters against a zod schema. Same contract as
 * parseBody: sends a 400 VALIDATION error and returns undefined on failure.
 */
export function parseParams<T>(
  schema: ZodType<T>,
  params: unknown,
  reply: FastifyReply,
): T | undefined {
  const result = schema.safeParse(params);
  if (!result.success) {
    sendError(
      reply,
      400,
      'VALIDATION',
      result.error.issues[0]?.message ?? 'Invalid request parameters',
    );
    return undefined;
  }
  return result.data;
}
