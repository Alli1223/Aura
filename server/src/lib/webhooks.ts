import { createHmac, randomBytes } from 'node:crypto';

import type { Webhook } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import { getPrisma } from '../db/client.js';

// Outbound webhook dispatcher. Admins register HTTP endpoints (the Webhook
// model) that subscribe to a set of event types; when a subscribed event
// fires we POST a signed JSON body to every enabled, subscribed endpoint.
//
// Delivery contract:
//   - body: { event, timestamp, data } (JSON)
//   - header X-Aura-Signature: "sha256=<hmac-sha256(rawBody, secret)>"
//   - a per-attempt AbortController timeout (WEBHOOK_TIMEOUT_MS)
//   - a single retry on failure (network error, timeout, or non-2xx)
//   - the outcome is recorded on the row (lastStatus / lastDeliveryAt)
//
// dispatchEvent is FIRE-AND-FORGET: it never throws and never blocks the
// caller's important work — a broken or slow webhook must never break a scan
// or a playback start. Callers `void dispatchEvent(...)`.

// ---------------------------------------------------------------------------
// Event types & payloads
// ---------------------------------------------------------------------------

/** Event types a webhook may subscribe to. */
export const WEBHOOK_EVENT_TYPES = ['media.added', 'playback.started'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/**
 * The synthetic event the admin "test" endpoint delivers. Not subscribable —
 * it is sent to a single webhook on demand regardless of its subscriptions.
 */
export const WEBHOOK_TEST_EVENT = 'ping';

/** Payload for `media.added` — a newly scanned top-level item (movie/show). */
export interface MediaAddedData {
  itemId: string;
  libraryId: string;
  type: string;
  title: string;
}

/** Payload for `playback.started`. */
export interface PlaybackStartedData {
  userId: string;
  mediaFileId: string;
  itemId: string;
  mode: 'direct' | 'transcode';
}

export type WebhookEventData = MediaAddedData | PlaybackStartedData | Record<string, unknown>;

/**
 * Maximum number of `media.added` events a single scan run may emit. A bulk
 * first scan can create thousands of items at once; announcing every one would
 * hammer subscribers, so when a scan creates MORE than this many new top-level
 * items we skip `media.added` emission for that run entirely (the items are
 * still added — they are simply not announced). Normal incremental scans add a
 * handful of items and are always announced.
 */
export const MEDIA_ADDED_EMISSION_CAP = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal fetch used for delivery; the real global fetch satisfies it. */
export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}
export type WebhookFetch = (url: string, request: WebhookRequest) => Promise<{ status: number }>;

/** A webhook target normalised from a DB row (events already parsed). */
export interface WebhookTarget {
  id: string;
  url: string;
  secret: string;
  events: readonly string[];
  enabled: boolean;
}

/** The outcome of delivering to one webhook. */
export interface DeliveryResult {
  webhookId: string;
  ok: boolean;
  /** HTTP status of the last attempt, or null if no response was received. */
  status: number | null;
  /** Number of attempts made (1, or 2 when the first failed and was retried). */
  attempts: number;
  /** Error message when the last attempt threw (timeout/network). */
  error?: string;
}

export interface DispatchDeps {
  /** Inject a fetch implementation (tests). Enables delivery under NODE_ENV=test. */
  fetch?: WebhookFetch;
  /** Pre-resolved targets (tests). When omitted, enabled webhooks load from the DB. */
  webhooks?: WebhookTarget[];
  /** Override the per-attempt timeout (default WEBHOOK_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Clock injection for a deterministic `timestamp` (tests). */
  now?: () => Date;
  log?: FastifyBaseLogger;
}

/** Signature of dispatchEvent, so callers/tests can inject a stand-in. */
export type DispatchFn = (
  eventType: WebhookEventType,
  data: WebhookEventData,
  deps?: DispatchDeps,
) => Promise<DeliveryResult[]>;

// ---------------------------------------------------------------------------
// Test-only fetch injection
// ---------------------------------------------------------------------------

// A module-level fetch stand-in installed by tests. When set, delivery uses it
// instead of the global fetch AND lifts the NODE_ENV=test no-op guard, so a
// test can exercise emission end-to-end without hitting the real network.
let moduleFetch: WebhookFetch | undefined;

/** Test-only: install (or clear with undefined) the delivery fetch impl. */
export function __setWebhookFetchForTests(fn: WebhookFetch | undefined): void {
  moduleFetch = fn;
}

function resolveFetch(explicit?: WebhookFetch): WebhookFetch {
  return explicit ?? moduleFetch ?? (globalThis.fetch as unknown as WebhookFetch);
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === 'test';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `sha256=<hex hmac>` of the raw request body under the webhook secret. */
export function signBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** A fresh random webhook signing secret (256 bits, base64url). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Masks a secret for display: only the last 4 characters survive. */
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return '••••';
  return `••••${secret.slice(-4)}`;
}

/** True for an absolute http(s) URL — the only schemes a webhook may target. */
export function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parses a stored events JSON array; a corrupt value means "no subscriptions". */
export function parseWebhookEvents(raw: string, log?: FastifyBaseLogger): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // fall through
  }
  log?.warn('webhook has invalid events JSON; treating as no subscriptions');
  return [];
}

/** Normalises a DB row into a delivery target (parses the events array). */
export function toWebhookTarget(row: Webhook, log?: FastifyBaseLogger): WebhookTarget {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    events: parseWebhookEvents(row.events, log),
    enabled: row.enabled,
  };
}

async function loadEnabledWebhooks(log?: FastifyBaseLogger): Promise<WebhookTarget[]> {
  const rows = await getPrisma().webhook.findMany({ where: { enabled: true } });
  return rows.map((row) => toWebhookTarget(row, log));
}

/** Best-effort record of a delivery outcome; never throws (row may be gone). */
async function recordDelivery(
  webhookId: string,
  status: number | null,
  at: Date,
  log?: FastifyBaseLogger,
): Promise<void> {
  try {
    await getPrisma().webhook.update({
      where: { id: webhookId },
      data: { lastStatus: status, lastDeliveryAt: at },
    });
  } catch (err) {
    log?.debug({ err, webhookId }, 'could not record webhook delivery status');
  }
}

interface AttemptResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

/** One POST attempt, aborted after `timeoutMs`. Never throws. */
async function attemptDelivery(
  url: string,
  rawBody: string,
  signature: string,
  eventType: string,
  fetchImpl: WebhookFetch,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aura-event': eventType,
        'x-aura-signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    const status = response.status;
    return { ok: status >= 200 && status < 300, status };
  } catch (err) {
    return { ok: false, status: null, error: message(err) };
  } finally {
    clearTimeout(timer);
  }
}

export interface DeliverOptions {
  fetch?: WebhookFetch;
  timeoutMs?: number;
  now?: () => Date;
  log?: FastifyBaseLogger;
}

/**
 * Delivers one event to one webhook: signs the body, POSTs it, retries once on
 * failure, and records the outcome on the row. Never throws — the failure is
 * captured in the returned DeliveryResult. Used both by dispatchEvent (per
 * subscriber) and by the admin "test" endpoint (a single `ping`).
 */
export async function deliverToWebhook(
  webhook: WebhookTarget,
  eventType: string,
  data: unknown,
  opts: DeliverOptions = {},
): Promise<DeliveryResult> {
  const fetchImpl = resolveFetch(opts.fetch);
  const timeoutMs = opts.timeoutMs ?? loadConfig().WEBHOOK_TIMEOUT_MS;
  const now = opts.now?.() ?? new Date();

  const rawBody = JSON.stringify({ event: eventType, timestamp: now.toISOString(), data });
  const signature = signBody(rawBody, webhook.secret);

  let attempt = await attemptDelivery(webhook.url, rawBody, signature, eventType, fetchImpl, timeoutMs);
  let attempts = 1;
  if (!attempt.ok) {
    attempt = await attemptDelivery(webhook.url, rawBody, signature, eventType, fetchImpl, timeoutMs);
    attempts = 2;
  }

  await recordDelivery(webhook.id, attempt.status, new Date(), opts.log);

  return {
    webhookId: webhook.id,
    ok: attempt.ok,
    status: attempt.status,
    attempts,
    ...(attempt.error !== undefined ? { error: attempt.error } : {}),
  };
}

/**
 * Dispatches an event to every enabled webhook subscribed to it. Fire-and-
 * forget: it never throws and resolves to the per-webhook results (tests may
 * await them; production callers `void` it). One failing webhook never stops
 * the others — deliveries run concurrently and each captures its own failure.
 *
 * Test safety: under NODE_ENV=test this is a no-op UNLESS a fetch impl is wired
 * up (deps.fetch or __setWebhookFetchForTests), so ordinary scan/playback tests
 * never touch the network; a test that wants to observe emission installs one.
 */
export async function dispatchEvent(
  eventType: WebhookEventType,
  data: WebhookEventData,
  deps: DispatchDeps = {},
): Promise<DeliveryResult[]> {
  if (isTestEnv() && deps.fetch === undefined && moduleFetch === undefined) {
    return [];
  }
  try {
    const targets = deps.webhooks ?? (await loadEnabledWebhooks(deps.log));
    const subscribed = targets.filter(
      (target) => target.enabled && target.events.includes(eventType),
    );
    if (subscribed.length === 0) return [];

    const fetchImpl = resolveFetch(deps.fetch);
    const timeoutMs = deps.timeoutMs ?? loadConfig().WEBHOOK_TIMEOUT_MS;
    return await Promise.all(
      subscribed.map((target) =>
        deliverToWebhook(target, eventType, data, {
          fetch: fetchImpl,
          timeoutMs,
          now: deps.now,
          log: deps.log,
        }),
      ),
    );
  } catch (err) {
    deps.log?.error({ err, event: eventType }, 'webhook dispatch failed');
    return [];
  }
}
