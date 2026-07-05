import type { ApiToken } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createApiToken } from '../auth/api-tokens.js';
import { getPrisma } from '../db/client.js';
import { apiTokenScopeSchema } from '../db/constants.js';
import { writeAuditLog } from '../lib/audit.js';
import { sendError } from '../lib/errors.js';
import { parseBody, parseParams } from '../lib/validation.js';

// Personal API token management. All routes require an authenticated user
// (JWT), and additionally REJECT requests that authenticated via an API token
// themselves: a token can never mint, list or revoke tokens (self-propagation
// / privilege-laundering defence). Tokens are always scoped to the caller —
// there is no cross-user access, and other users' tokens are cloaked as 404.

const API_TOKEN_NOT_FOUND_MESSAGE = 'API token not found';

const tokenIdParamsSchema = z.object({ id: z.string().min(1, 'Token id is required') });

/** ISO 8601 datetime that must be in the future. */
const futureExpiry = z
  .string('expiresAt must be an ISO 8601 datetime string')
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'expiresAt must be a valid ISO 8601 datetime',
  })
  .transform((value) => new Date(value))
  .refine((date) => date.getTime() > Date.now(), { message: 'expiresAt must be in the future' });

const createApiTokenSchema = z.object({
  name: z.string('Name is required').trim().min(1, 'Name is required').max(100, 'Name is too long'),
  scope: apiTokenScopeSchema,
  expiresAt: futureExpiry.optional(),
});

/** Public metadata shape of a token. Never includes the hash or raw token. */
function toPublicApiToken(token: ApiToken) {
  return {
    id: token.id,
    name: token.name,
    scope: token.scope,
    prefix: token.prefix,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    revokedAt: token.revokedAt,
  };
}

/**
 * preHandler (composed after `authenticate`) that blocks requests which
 * authenticated via an API token. Prevents a token from managing tokens.
 */
async function rejectApiTokenAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.authMethod === 'api-token') {
    sendError(
      reply,
      403,
      'API_TOKEN_FORBIDDEN',
      'API tokens cannot manage API tokens; use an interactive session',
    );
  }
}

export const apiTokenRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  // Interactive (JWT) session required; API-token-authed requests are rejected.
  const interactiveOnly = { preHandler: [app.authenticate, rejectApiTokenAuth] };

  // List the caller's own tokens (newest first). Never leaks hash/raw token.
  app.get('/', interactiveOnly, async (request) => {
    const tokens = await prisma.apiToken.findMany({
      where: { userId: request.user.id },
      orderBy: { createdAt: 'desc' },
    });
    return { tokens: tokens.map(toPublicApiToken) };
  });

  // Create a token. The RAW token is returned exactly once, in `plaintext`;
  // it is never retrievable afterwards.
  app.post('/', interactiveOnly, async (request, reply) => {
    const body = parseBody(createApiTokenSchema, request.body, reply);
    if (body === undefined) return reply;

    const { record, rawToken } = await createApiToken(prisma, {
      userId: request.user.id,
      name: body.name,
      scope: body.scope,
      expiresAt: body.expiresAt ?? null,
    });

    await writeAuditLog(
      prisma,
      {
        action: 'api_token.created',
        userId: request.user.id,
        targetType: 'api_token',
        targetId: record.id,
        ip: request.ip,
        // Deliberately records only the name + scope — never the token itself.
        details: { name: record.name, scope: record.scope },
      },
      request.log,
    );

    return reply.status(201).send({ token: toPublicApiToken(record), plaintext: rawToken });
  });

  // Revoke a token. Idempotent (revoking an already-revoked token still 204s),
  // owner-only: another user's token — or a non-existent id — is cloaked as 404.
  app.delete('/:id', interactiveOnly, async (request, reply) => {
    const params = parseParams(tokenIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const token = await prisma.apiToken.findUnique({ where: { id: params.id } });
    if (token === null || token.userId !== request.user.id) {
      return sendError(reply, 404, 'NOT_FOUND', API_TOKEN_NOT_FOUND_MESSAGE);
    }

    if (token.revokedAt === null) {
      await prisma.apiToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
      await writeAuditLog(
        prisma,
        {
          action: 'api_token.revoked',
          userId: request.user.id,
          targetType: 'api_token',
          targetId: token.id,
          ip: request.ip,
          details: { name: token.name, scope: token.scope },
        },
        request.log,
      );
    }

    return reply.status(204).send();
  });
};
