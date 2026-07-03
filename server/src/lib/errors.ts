import type { FastifyReply } from 'fastify';

/** Consistent JSON error shape returned by every endpoint. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Sends `{ error: { code, message } }` with the given status code. */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ApiErrorBody = { error: { code, message } };
  return reply.status(statusCode).send(body);
}

/**
 * Throwable counterpart of sendError for code that runs away from a reply
 * (helpers, services, hooks). The app-level error handler serialises it to
 * the same `{ error: { code, message } }` shape via statusCode/code.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 403 with the standard FORBIDDEN code. */
export function forbiddenError(message = 'You do not have access to this resource'): ApiError {
  return new ApiError(403, 'FORBIDDEN', message);
}

/** 404 with the standard NOT_FOUND code. */
export function notFoundError(message = 'Not found'): ApiError {
  return new ApiError(404, 'NOT_FOUND', message);
}
