import type { Webhook } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { sendError } from '../lib/errors.js';
import { parseBody, parseParams } from '../lib/validation.js';
import {
  deliverToWebhook,
  generateWebhookSecret,
  isHttpUrl,
  maskSecret,
  parseWebhookEvents,
  toWebhookTarget,
  webhookEventTypeSchema,
  WEBHOOK_TEST_EVENT,
} from '../lib/webhooks.js';

// Admin API to manage outbound webhooks. Every route is admin-only. The signing
// secret is write-once: it is revealed in full exactly once (in the create
// response) and never afterwards — listings expose only a masked hint.

const WEBHOOK_NOT_FOUND_MESSAGE = 'Webhook not found';

const idParamsSchema = z.object({ id: z.string().min(1, 'Webhook id is required') });

const nameSchema = z
  .string('Name is required')
  .trim()
  .min(1, 'Name is required')
  .max(100, 'Name is too long');

const urlSchema = z
  .string('url is required')
  .trim()
  .refine((value) => isHttpUrl(value), { message: 'url must be an http(s) URL' });

const eventsSchema = z
  .array(webhookEventTypeSchema, 'events must be an array of event types')
  .min(1, 'At least one event is required')
  // Dedupe so a subscription is never recorded twice.
  .transform((events) => [...new Set(events)]);

const secretSchema = z
  .string('secret must be a string')
  .min(1, 'secret must not be empty')
  .max(512, 'secret is too long');

const createWebhookSchema = z.object({
  name: nameSchema,
  url: urlSchema,
  events: eventsSchema,
  secret: secretSchema.optional(),
});

const updateWebhookSchema = z
  .object({
    name: nameSchema,
    url: urlSchema,
    events: eventsSchema,
    enabled: z.boolean('enabled must be a boolean'),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided',
  });

/** Public shape of a webhook. The secret is masked — never returned in full. */
function toPublicWebhook(row: Webhook) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: parseWebhookEvents(row.events),
    enabled: row.enabled,
    secretMask: maskSecret(row.secret),
    lastStatus: row.lastStatus,
    lastDeliveryAt: row.lastDeliveryAt,
    createdAt: row.createdAt,
  };
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // List all webhooks (newest first). Never leaks a full secret.
  app.get('/', adminOnly, async () => {
    const rows = await prisma.webhook.findMany({ orderBy: { createdAt: 'desc' } });
    return { webhooks: rows.map(toPublicWebhook) };
  });

  // Create a webhook. The signing secret is generated when omitted and returned
  // in full exactly once, in `secret`; it is never retrievable afterwards.
  app.post('/', adminOnly, async (request, reply) => {
    const body = parseBody(createWebhookSchema, request.body, reply);
    if (body === undefined) return reply;

    const secret = body.secret ?? generateWebhookSecret();
    const created = await prisma.webhook.create({
      data: {
        name: body.name,
        url: body.url,
        events: JSON.stringify(body.events),
        secret,
      },
    });

    await writeAuditLog(
      prisma,
      {
        action: 'webhook.created',
        userId: request.user.id,
        targetType: 'webhook',
        targetId: created.id,
        ip: request.ip,
        // Deliberately records name/url/events — never the secret.
        details: { name: created.name, url: created.url, events: body.events },
      },
      request.log,
    );

    return reply.status(201).send({ webhook: toPublicWebhook(created), secret });
  });

  // Update a webhook (name/url/events/enabled). 404 for an unknown id.
  app.patch('/:id', adminOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;
    const body = parseBody(updateWebhookSchema, request.body, reply);
    if (body === undefined) return reply;

    const existing = await prisma.webhook.findUnique({ where: { id: params.id } });
    if (existing === null) {
      return sendError(reply, 404, 'NOT_FOUND', WEBHOOK_NOT_FOUND_MESSAGE);
    }

    const updated = await prisma.webhook.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.events !== undefined ? { events: JSON.stringify(body.events) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    });

    await writeAuditLog(
      prisma,
      {
        action: 'webhook.updated',
        userId: request.user.id,
        targetType: 'webhook',
        targetId: updated.id,
        ip: request.ip,
        details: { changed: Object.keys(body) },
      },
      request.log,
    );

    return { webhook: toPublicWebhook(updated) };
  });

  // Delete a webhook. Idempotent: an unknown id still 204s.
  app.delete('/:id', adminOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const existing = await prisma.webhook.findUnique({ where: { id: params.id } });
    if (existing !== null) {
      await prisma.webhook.delete({ where: { id: params.id } });
      await writeAuditLog(
        prisma,
        {
          action: 'webhook.deleted',
          userId: request.user.id,
          targetType: 'webhook',
          targetId: existing.id,
          ip: request.ip,
          details: { name: existing.name, url: existing.url },
        },
        request.log,
      );
    }

    return reply.status(204).send();
  });

  // Send a synthetic `ping` to one webhook and return the delivery outcome.
  app.post('/:id/test', adminOnly, async (request, reply) => {
    const params = parseParams(idParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const row = await prisma.webhook.findUnique({ where: { id: params.id } });
    if (row === null) {
      return sendError(reply, 404, 'NOT_FOUND', WEBHOOK_NOT_FOUND_MESSAGE);
    }

    const result = await deliverToWebhook(
      toWebhookTarget(row, request.log),
      WEBHOOK_TEST_EVENT,
      { webhookId: row.id, message: 'Aura webhook test delivery' },
      { log: request.log },
    );

    return {
      delivery: {
        ok: result.ok,
        status: result.status,
        attempts: result.attempts,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    };
  });
};
