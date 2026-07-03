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
