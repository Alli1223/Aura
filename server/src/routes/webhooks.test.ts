import { execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { disconnectPrisma, getPrisma } from '../db/client.js';
import {
  __setWebhookFetchForTests,
  type WebhookFetch,
  type WebhookRequest,
} from '../lib/webhooks.js';

// Integration tests for the admin webhook API + the playback.started emission
// point. Runs against a real temporary SQLite database. No real network: the
// /test endpoint and the playback emission use an injected fetch impl.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const PASSWORD = 'correct-horse-battery';

let tempDir: string;
let prisma: PrismaClient;
let app: FastifyInstance;

interface Session {
  id: string;
  username: string;
  accessToken: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}
interface PublicWebhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secretMask: string;
  lastStatus: number | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

let admin: Session;
let user: Session;

interface RecordedCall {
  url: string;
  request: WebhookRequest;
}
function recordingFetch(status = 200): { fetch: WebhookFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: WebhookFetch = (url, request) => {
    calls.push({ url, request });
    return Promise.resolve({ status });
  };
  return { fetch, calls };
}

function inject(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(options);
}
function jwtAuth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function registerUser(): Promise<Session> {
  const username = `wh-${randomUUID().slice(0, 18)}`;
  const response = await inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ user: { id: string }; accessToken: string }>();
  return { id: body.user.id, username, accessToken: body.accessToken };
}

async function createWebhook(
  payload: Record<string, unknown>,
  session: Session = admin,
): Promise<{ webhook: PublicWebhook; secret: string }> {
  const response = await inject({
    method: 'POST',
    url: '/api/webhooks',
    headers: jwtAuth(session.accessToken),
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ webhook: PublicWebhook; secret: string }>();
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-webhook-route-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  process.env.CONFIG_DIR = path.join(tempDir, 'config');
  prisma = getPrisma();
  app = buildApp();
  await app.ready();
  admin = await registerUser(); // first user => admin
  user = await registerUser();
}, 120_000);

afterEach(() => {
  __setWebhookFetchForTests(undefined);
});

afterAll(async () => {
  await app.close();
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('POST /api/webhooks', () => {
  it('creates a webhook, returns the secret once, and audits without the secret', async () => {
    const { webhook, secret } = await createWebhook({
      name: 'CI notifier',
      url: 'https://hooks.example.com/aura',
      events: ['media.added', 'playback.started'],
    });

    expect(webhook.name).toBe('CI notifier');
    expect(webhook.url).toBe('https://hooks.example.com/aura');
    expect(webhook.events).toEqual(['media.added', 'playback.started']);
    expect(webhook.enabled).toBe(true);
    // Full secret returned once; the public object only carries a mask.
    expect(secret.length).toBeGreaterThan(8);
    expect(webhook.secretMask.startsWith('••••')).toBe(true);
    expect(JSON.stringify(webhook)).not.toContain(secret);

    const stored = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
    expect(stored.secret).toBe(secret);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'webhook.created', targetId: webhook.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(admin.id);
    expect(audit!.details).not.toContain(secret);
    const details = JSON.parse(audit!.details ?? '{}') as Record<string, unknown>;
    expect(details).toMatchObject({ name: 'CI notifier', url: 'https://hooks.example.com/aura' });
  });

  it('generates a secret when none is supplied', async () => {
    const { secret } = await createWebhook({
      name: 'auto-secret',
      url: 'https://hooks.example.com/x',
      events: ['media.added'],
    });
    expect(typeof secret).toBe('string');
    expect(secret.length).toBeGreaterThan(16);
  });

  it('honours a caller-supplied secret', async () => {
    const { webhook, secret } = await createWebhook({
      name: 'byo-secret',
      url: 'https://hooks.example.com/y',
      events: ['media.added'],
      secret: 'my-own-secret-value',
    });
    expect(secret).toBe('my-own-secret-value');
    const stored = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
    expect(stored.secret).toBe('my-own-secret-value');
  });

  it('dedupes subscribed events', async () => {
    const { webhook } = await createWebhook({
      name: 'dupes',
      url: 'https://hooks.example.com/z',
      events: ['media.added', 'media.added'],
    });
    expect(webhook.events).toEqual(['media.added']);
  });

  it.each([
    ['non-http url', { name: 'x', url: 'ftp://nope.example.com', events: ['media.added'] }],
    ['garbage url', { name: 'x', url: 'not a url', events: ['media.added'] }],
    ['empty events', { name: 'x', url: 'https://a.example.com', events: [] }],
    ['unknown event', { name: 'x', url: 'https://a.example.com', events: ['media.removed'] }],
    ['missing name', { url: 'https://a.example.com', events: ['media.added'] }],
  ])('rejects %s with 400 VALIDATION', async (_label, payload) => {
    const response = await inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: jwtAuth(admin.accessToken),
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe('GET /api/webhooks', () => {
  it('lists webhooks with masked secrets and never leaks a full secret', async () => {
    const { webhook, secret } = await createWebhook({
      name: 'listed',
      url: 'https://hooks.example.com/listed',
      events: ['media.added'],
    });

    const response = await inject({
      method: 'GET',
      url: '/api/webhooks',
      headers: jwtAuth(admin.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const { webhooks } = response.json<{ webhooks: PublicWebhook[] }>();
    const found = webhooks.find((w) => w.id === webhook.id);
    expect(found).toBeDefined();
    expect(found!.secretMask.startsWith('••••')).toBe(true);
    // The full secret must appear nowhere in the listing body.
    expect(response.body).not.toContain(secret);
    expect(response.body.toLowerCase()).not.toContain('"secret"');
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe('PATCH /api/webhooks/:id', () => {
  it('updates fields and audits webhook.updated', async () => {
    const { webhook } = await createWebhook({
      name: 'before',
      url: 'https://hooks.example.com/before',
      events: ['media.added'],
    });

    const response = await inject({
      method: 'PATCH',
      url: `/api/webhooks/${webhook.id}`,
      headers: jwtAuth(admin.accessToken),
      payload: { name: 'after', enabled: false, events: ['playback.started'] },
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json<{ webhook: PublicWebhook }>().webhook;
    expect(updated.name).toBe('after');
    expect(updated.enabled).toBe(false);
    expect(updated.events).toEqual(['playback.started']);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'webhook.updated', targetId: webhook.id },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects an invalid url with 400', async () => {
    const { webhook } = await createWebhook({
      name: 'patch-bad-url',
      url: 'https://hooks.example.com/pbu',
      events: ['media.added'],
    });
    const response = await inject({
      method: 'PATCH',
      url: `/api/webhooks/${webhook.id}`,
      headers: jwtAuth(admin.accessToken),
      payload: { url: 'javascript:alert(1)' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION');
  });

  it('404s an unknown id', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/webhooks/does-not-exist',
      headers: jwtAuth(admin.accessToken),
      payload: { name: 'x' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('DELETE /api/webhooks/:id', () => {
  it('deletes (204), is idempotent, and audits', async () => {
    const { webhook } = await createWebhook({
      name: 'to-delete',
      url: 'https://hooks.example.com/del',
      events: ['media.added'],
    });

    const first = await inject({
      method: 'DELETE',
      url: `/api/webhooks/${webhook.id}`,
      headers: jwtAuth(admin.accessToken),
    });
    expect(first.statusCode).toBe(204);
    expect(await prisma.webhook.findUnique({ where: { id: webhook.id } })).toBeNull();

    // Idempotent: deleting again still 204.
    const second = await inject({
      method: 'DELETE',
      url: `/api/webhooks/${webhook.id}`,
      headers: jwtAuth(admin.accessToken),
    });
    expect(second.statusCode).toBe(204);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'webhook.deleted', targetId: webhook.id },
    });
    expect(audit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test delivery
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/:id/test', () => {
  it('delivers a signed ping and returns the delivery status', async () => {
    const { webhook, secret } = await createWebhook({
      name: 'pingable',
      url: 'https://hooks.example.com/ping',
      events: ['media.added'],
    });
    const { fetch, calls } = recordingFetch(200);
    __setWebhookFetchForTests(fetch);

    const response = await inject({
      method: 'POST',
      url: `/api/webhooks/${webhook.id}/test`,
      headers: jwtAuth(admin.accessToken),
    });
    expect(response.statusCode).toBe(200);
    const { delivery } = response.json<{ delivery: { ok: boolean; status: number } }>();
    expect(delivery).toMatchObject({ ok: true, status: 200 });

    expect(calls).toHaveLength(1);
    const { body, headers } = calls[0]!.request;
    const parsed = JSON.parse(body) as { event: string };
    expect(parsed.event).toBe('ping');
    const expectedSig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(headers['x-aura-signature']).toBe(expectedSig);

    // The outcome is recorded on the row.
    const stored = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id } });
    expect(stored.lastStatus).toBe(200);
    expect(stored.lastDeliveryAt).not.toBeNull();
  });

  it('404s an unknown id', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/webhooks/nope/test',
      headers: jwtAuth(admin.accessToken),
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('admin-only access control', () => {
  const routes: Array<[string, InjectOptions]> = [
    ['list', { method: 'GET', url: '/api/webhooks' }],
    [
      'create',
      {
        method: 'POST',
        url: '/api/webhooks',
        payload: { name: 'x', url: 'https://a.example.com', events: ['media.added'] },
      },
    ],
    ['patch', { method: 'PATCH', url: '/api/webhooks/some-id', payload: { name: 'x' } }],
    ['delete', { method: 'DELETE', url: '/api/webhooks/some-id' }],
    ['test', { method: 'POST', url: '/api/webhooks/some-id/test' }],
  ];

  it.each(routes)('%s returns 403 for a non-admin user', async (_label, options) => {
    const response = await inject({ ...options, headers: jwtAuth(user.accessToken) });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it.each(routes)('%s returns 401 when unauthenticated', async (_label, options) => {
    const response = await inject(options);
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// playback.started emission (via the decide route)
// ---------------------------------------------------------------------------

describe('playback.started emission', () => {
  it('emits playback.started when playback is decided', async () => {
    // Isolate: clear webhooks left by earlier tests (some subscribe to
    // playback.started) so the assertions below are deterministic.
    await prisma.webhook.deleteMany({});
    // A subscriber for playback.started, plus a distractor for media.added only.
    await createWebhook({
      name: 'playback-sub',
      url: 'https://hooks.example.com/playback',
      events: ['playback.started'],
    });
    await createWebhook({
      name: 'media-only',
      url: 'https://hooks.example.com/media-only',
      events: ['media.added'],
    });

    const library = await prisma.library.create({
      data: {
        name: `plib-${randomUUID().slice(0, 8)}`,
        type: 'movies',
        paths: { create: [{ path: '/media/movies' }] },
      },
    });
    const item = await prisma.mediaItem.create({
      data: { libraryId: library.id, type: 'movie', title: 'Playable', sortTitle: 'Playable' },
    });
    const file = await prisma.mediaFile.create({
      data: {
        mediaItemId: item.id,
        path: `/media/movies/${randomUUID()}.mkv`,
        size: 1n,
        mtimeMs: 1n,
        container: 'mp4',
        videoCodec: 'h264',
      },
    });

    const { fetch, calls } = recordingFetch(200);
    __setWebhookFetchForTests(fetch);

    const response = await inject({
      method: 'POST',
      url: `/api/stream/decide/${file.id}`,
      headers: jwtAuth(admin.accessToken),
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    // Emission is fire-and-forget: wait for the delivery to land.
    for (let i = 0; i < 40 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Exactly the playback.started subscriber is hit (not the media-only one).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hooks.example.com/playback');
    const payload = JSON.parse(calls[0]!.request.body) as {
      event: string;
      data: { userId: string; mediaFileId: string; itemId: string; mode: string };
    };
    expect(payload.event).toBe('playback.started');
    expect(payload.data).toMatchObject({
      userId: admin.id,
      mediaFileId: file.id,
      itemId: item.id,
    });
    expect(['direct', 'transcode']).toContain(payload.data.mode);
  });
});
