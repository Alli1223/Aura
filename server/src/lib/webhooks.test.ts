import { execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { disconnectPrisma, getPrisma } from '../db/client.js';
import {
  __setWebhookFetchForTests,
  dispatchEvent,
  signBody,
  type WebhookFetch,
  type WebhookRequest,
  type WebhookTarget,
} from './webhooks.js';

// Dispatcher unit tests. Delivery never touches the real network: every test
// injects a fetch impl (deps.fetch) or the module-level test fetch. Runs
// against a real temporary SQLite database so the lastStatus/lastDeliveryAt
// bookkeeping (an UPDATE on the row) can be asserted.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tempDir: string;
let prisma: PrismaClient;

interface RecordedCall {
  url: string;
  request: WebhookRequest;
}

/** A fetch mock that records every call and returns a fixed status. */
function recordingFetch(status = 200): { fetch: WebhookFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: WebhookFetch = (url, request) => {
    calls.push({ url, request });
    return Promise.resolve({ status });
  };
  return { fetch, calls };
}

async function createWebhookRow(overrides: {
  events: string[];
  enabled?: boolean;
  url?: string;
  secret?: string;
}): Promise<WebhookTarget> {
  const row = await prisma.webhook.create({
    data: {
      name: `wh-${randomUUID().slice(0, 8)}`,
      url: overrides.url ?? 'https://example.test/hook',
      events: JSON.stringify(overrides.events),
      secret: overrides.secret ?? 'test-secret',
      enabled: overrides.enabled ?? true,
    },
  });
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    events: overrides.events,
    enabled: row.enabled,
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'aura-webhook-unit-'));
  const databaseUrl = `file:${path.join(tempDir, 'test.db')}`;
  execSync('npx prisma migrate deploy', {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  process.env.DATABASE_URL = databaseUrl;
  prisma = getPrisma();
}, 120_000);

afterEach(() => {
  __setWebhookFetchForTests(undefined);
});

afterAll(async () => {
  await disconnectPrisma();
  await rm(tempDir, { recursive: true, force: true });
});

describe('dispatchEvent', () => {
  it('POSTs a { event, timestamp, data } body only to enabled, subscribed webhooks', async () => {
    const { fetch, calls } = recordingFetch(200);
    const subscribed: WebhookTarget = {
      id: 'a',
      url: 'https://example.test/a',
      secret: 's1',
      events: ['media.added'],
      enabled: true,
    };
    const unsubscribed: WebhookTarget = {
      id: 'b',
      url: 'https://example.test/b',
      secret: 's2',
      events: ['playback.started'],
      enabled: true,
    };
    const disabled: WebhookTarget = {
      id: 'c',
      url: 'https://example.test/c',
      secret: 's3',
      events: ['media.added'],
      enabled: false,
    };

    const data = { itemId: 'i1', libraryId: 'l1', type: 'movie', title: 'Dune' };
    const now = new Date('2026-07-06T00:00:00.000Z');
    const results = await dispatchEvent('media.added', data, {
      fetch,
      webhooks: [subscribed, unsubscribed, disabled],
      now: () => now,
    });

    // Only the enabled + subscribed webhook was called.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.test/a');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ webhookId: 'a', ok: true, status: 200, attempts: 1 });

    const body = JSON.parse(calls[0]!.request.body) as Record<string, unknown>;
    expect(body).toEqual({
      event: 'media.added',
      timestamp: now.toISOString(),
      data,
    });
    expect(calls[0]!.request.method).toBe('POST');
    expect(calls[0]!.request.headers['content-type']).toBe('application/json');
    expect(calls[0]!.request.headers['x-aura-event']).toBe('media.added');
  });

  it('signs the body with X-Aura-Signature: sha256=<hmac(rawBody, secret)>', async () => {
    const { fetch, calls } = recordingFetch(204);
    const target: WebhookTarget = {
      id: 'sig',
      url: 'https://example.test/sig',
      secret: 'super-secret-key',
      events: ['media.added'],
      enabled: true,
    };
    await dispatchEvent(
      'media.added',
      { itemId: 'i', libraryId: 'l', type: 'movie', title: 'X' },
      { fetch, webhooks: [target] },
    );

    const { body, headers } = calls[0]!.request;
    const expected = `sha256=${createHmac('sha256', 'super-secret-key').update(body).digest('hex')}`;
    expect(headers['x-aura-signature']).toBe(expected);
    // And the exported helper agrees with the header the dispatcher sent.
    expect(signBody(body, 'super-secret-key')).toBe(headers['x-aura-signature']);
  });

  it('skips a disabled webhook and an unsubscribed one entirely (no POST)', async () => {
    const { fetch, calls } = recordingFetch(200);
    const results = await dispatchEvent(
      'media.added',
      { itemId: 'i', libraryId: 'l', type: 'movie', title: 'X' },
      {
        fetch,
        webhooks: [
          { id: 'd', url: 'u', secret: 's', events: ['media.added'], enabled: false },
          { id: 'u', url: 'u', secret: 's', events: ['playback.started'], enabled: true },
        ],
      },
    );
    expect(calls).toHaveLength(0);
    expect(results).toHaveLength(0);
  });

  it('aborts on timeout and records the failure without throwing', async () => {
    const target = await createWebhookRow({ events: ['media.added'] });
    // Never resolves until the AbortController fires.
    const hangingFetch: WebhookFetch = (_url, request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const results = await dispatchEvent(
      'media.added',
      { itemId: 'i', libraryId: 'l', type: 'movie', title: 'X' },
      { fetch: hangingFetch, webhooks: [target], timeoutMs: 20 },
    );

    expect(results[0]).toMatchObject({ ok: false, status: null, attempts: 2 });
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.lastStatus).toBeNull();
    expect(row.lastDeliveryAt).not.toBeNull();
  });

  it('retries once on failure, then records the final status', async () => {
    const target = await createWebhookRow({ events: ['media.added'] });
    const fetch = vi
      .fn<WebhookFetch>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ status: 200 });

    const results = await dispatchEvent(
      'media.added',
      { itemId: 'i', libraryId: 'l', type: 'movie', title: 'X' },
      { fetch, webhooks: [target] },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results[0]).toMatchObject({ ok: true, status: 200, attempts: 2 });
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.lastStatus).toBe(200);
  });

  it('records a non-2xx status as a failure (after the retry)', async () => {
    const target = await createWebhookRow({ events: ['media.added'] });
    const { fetch } = recordingFetch(500);
    const results = await dispatchEvent(
      'media.added',
      { itemId: 'i', libraryId: 'l', type: 'movie', title: 'X' },
      { fetch, webhooks: [target] },
    );
    expect(results[0]).toMatchObject({ ok: false, status: 500, attempts: 2 });
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.lastStatus).toBe(500);
  });

  it('one failing webhook does not stop delivery to the others', async () => {
    const failing: WebhookTarget = {
      id: 'fail',
      url: 'https://example.test/fail',
      secret: 's',
      events: ['media.added'],
      enabled: true,
    };
    const ok: WebhookTarget = {
      id: 'ok',
      url: 'https://example.test/ok',
      secret: 's',
      events: ['media.added'],
      enabled: true,
    };
    const fetch: WebhookFetch = (url) =>
      url.endsWith('/fail')
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ status: 200 });

    const results = await dispatchEvent(
      'media.added',
      { itemId: 'i', libraryId: 'l', type: 'movie', title: 'X' },
      { fetch, webhooks: [failing, ok] },
    );

    const byId = new Map(results.map((r) => [r.webhookId, r]));
    expect(byId.get('ok')).toMatchObject({ ok: true, status: 200 });
    expect(byId.get('fail')).toMatchObject({ ok: false, status: null, attempts: 2 });
  });

  it('loads enabled subscribers from the database when no list is injected', async () => {
    const target = await createWebhookRow({ events: ['media.added'], url: 'https://db.test/hook' });
    await createWebhookRow({ events: ['media.added'], enabled: false, url: 'https://db.test/off' });
    const { fetch, calls } = recordingFetch(200);

    // Install via the module-level test fetch (no deps.fetch), exercising the
    // DB-load path.
    __setWebhookFetchForTests(fetch);
    const results = await dispatchEvent('media.added', {
      itemId: 'i',
      libraryId: 'l',
      type: 'movie',
      title: 'X',
    });

    // Only the enabled DB row that subscribes to media.added should be hit —
    // among possibly many rows created by earlier tests, our two URLs let us
    // assert precisely.
    const hitUrls = calls.map((c) => c.url);
    expect(hitUrls).toContain('https://db.test/hook');
    expect(hitUrls).not.toContain('https://db.test/off');
    expect(results.some((r) => r.webhookId === target.id && r.ok)).toBe(true);
  });

  it('is a no-op under NODE_ENV=test when no fetch is wired up', async () => {
    // No deps.fetch and no module fetch installed: must not attempt anything.
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const results = await dispatchEvent('media.added', {
      itemId: 'i',
      libraryId: 'l',
      type: 'movie',
      title: 'X',
    });
    expect(results).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });
});
