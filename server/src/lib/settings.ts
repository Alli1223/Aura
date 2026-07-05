import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';

import { loadConfig } from '../config.js';
import { getPrisma } from '../db/client.js';
import {
  DEFAULT_MAX_QUALITY,
  DEFAULT_QUALITY,
  qualityNameSchema,
  type HlsQualityName,
} from '../streaming/quality-ladder.js';
import { ApiError } from './errors.js';

// Typed server-settings store over the Setting key/value model. Values are
// JSON-encoded in the database; every known setting has a zod schema and a
// default. Reads go through a small in-memory cache that is write-through
// updated by setSettings (and clearable for tests / cross-instance reloads).

/** Typed values of every known server setting. */
export interface Settings {
  /** Display name of this server (login page, clients). */
  serverName: string;
  /** Whether new accounts may self-register (first user is always allowed). */
  registrationEnabled: boolean;
  /** External URL of this server ("" = unset), e.g. "https://media.example.com". */
  baseUrl: string;
  /** Scratch directory for HLS transcode output. */
  transcodeDir: string;
  /**
   * Default transcode quality offered to players (one of the quality-ladder
   * rung names). Applied when a client does not request a specific rung.
   */
  defaultQuality: HlsQualityName;
  /**
   * Server-wide maximum transcode quality (a quality-ladder rung name). A hard
   * ceiling: no user's effective cap can exceed it, and every requested/chosen
   * rung is clamped to it (further lowered by any per-user cap).
   */
  maxQuality: HlsQualityName;
  /**
   * TMDB credential for metadata enrichment ("" = unset/disabled): either a
   * v3 API key or a v4 read access token (a JWT starting with "eyJ"); the
   * TMDB client detects which style it was given. SECRET — never expose via
   * unauthenticated routes and never log/audit its value.
   */
  tmdbApiKey: string;
}

export type SettingKey = keyof Settings;

/**
 * Accepts "" (unset) or an absolute http(s) URL without a trailing slash,
 * e.g. "https://media.example.com" or "http://host:8096/aura".
 */
function isValidBaseUrl(value: string): boolean {
  if (value.endsWith('/')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

const serverNameSchema = z
  .string('serverName must be a string')
  .trim()
  .min(1, 'serverName must be between 1 and 64 characters')
  .max(64, 'serverName must be between 1 and 64 characters');

const registrationEnabledSchema = z.boolean('registrationEnabled must be a boolean');

const baseUrlSchema = z
  .string('baseUrl must be a string')
  .refine((value) => value === '' || isValidBaseUrl(value), {
    message: 'baseUrl must be empty or an http(s) URL without a trailing slash',
  });

const transcodeDirSchema = z
  .string('transcodeDir must be a string')
  .min(1, 'transcodeDir must not be empty');

const defaultQualitySchema = qualityNameSchema;
const maxQualitySchema = qualityNameSchema;

const tmdbApiKeySchema = z
  .string('tmdbApiKey must be a string')
  .trim()
  .max(512, 'tmdbApiKey must be at most 512 characters');

interface SettingDefinition<T> {
  schema: z.ZodType<T>;
  /** Lazy so defaults can depend on runtime config (e.g. CONFIG_DIR). */
  defaultValue: () => T;
}

const registry: { [K in SettingKey]: SettingDefinition<Settings[K]> } = {
  serverName: { schema: serverNameSchema, defaultValue: () => 'Aura' },
  registrationEnabled: { schema: registrationEnabledSchema, defaultValue: () => true },
  baseUrl: { schema: baseUrlSchema, defaultValue: () => '' },
  transcodeDir: {
    schema: transcodeDirSchema,
    defaultValue: () => path.join(loadConfig().CONFIG_DIR, 'transcodes'),
  },
  defaultQuality: { schema: defaultQualitySchema, defaultValue: () => DEFAULT_QUALITY },
  maxQuality: { schema: maxQualitySchema, defaultValue: () => DEFAULT_MAX_QUALITY },
  tmdbApiKey: { schema: tmdbApiKeySchema, defaultValue: () => '' },
};

/** All known setting keys. Unknown keys are rejected everywhere. */
export const SETTING_KEYS = Object.keys(registry) as SettingKey[];

/**
 * Settings whose values are secrets. Their values must never be written to
 * logs or audit details (redact to key names / "[REDACTED]") and must never
 * be returned by unauthenticated routes.
 */
export const SECRET_SETTING_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>(['tmdbApiKey']);

/**
 * Partial-update schema for the admin PATCH endpoint and setSettings.
 * Strict: unknown keys are a validation error, and at least one known
 * setting must be provided.
 */
export const settingsPatchSchema = z
  .object({
    serverName: serverNameSchema,
    registrationEnabled: registrationEnabledSchema,
    baseUrl: baseUrlSchema,
    transcodeDir: transcodeDirSchema,
    defaultQuality: defaultQualitySchema,
    maxQuality: maxQualitySchema,
    tmdbApiKey: tmdbApiKeySchema,
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one setting must be provided',
  });

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// In-memory cache of decoded setting values. The server is a single process,
// and every write goes through setSettings (write-through), so entries can
// only go stale if the DB is edited out-of-band — clearSettingsCache covers
// tests and manual reloads.
const cache = new Map<SettingKey, Settings[SettingKey]>();

/** Drops every cached value so the next read hits the database. */
export function clearSettingsCache(): void {
  cache.clear();
}

/**
 * Decodes a stored (JSON-encoded) value for `key`. Invalid JSON or values
 * that fail the setting's schema log a warning and fall back to the default,
 * so a corrupted row can never take the server down.
 */
function decodeStoredValue<K extends SettingKey>(
  key: K,
  raw: string,
  log?: FastifyBaseLogger,
): Settings[K] {
  const definition = registry[key];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.warn({ settingKey: key }, 'stored setting is not valid JSON; falling back to default');
    return definition.defaultValue();
  }
  const result = definition.schema.safeParse(parsed);
  if (!result.success) {
    log?.warn(
      { settingKey: key, issue: result.error.issues[0]?.message },
      'stored setting failed validation; falling back to default',
    );
    return definition.defaultValue();
  }
  return result.data;
}

/**
 * Returns the typed value of a single setting: the stored value when present
 * and valid, otherwise the default.
 */
export async function getSetting<K extends SettingKey>(
  key: K,
  log?: FastifyBaseLogger,
): Promise<Settings[K]> {
  if (cache.has(key)) return cache.get(key) as Settings[K];
  const row = await getPrisma().setting.findUnique({ where: { key } });
  const value =
    row === null ? registry[key].defaultValue() : decodeStoredValue(key, row.value, log);
  cache.set(key, value);
  return value;
}

/** Returns every known setting with its typed (stored or default) value. */
export async function getAllSettings(log?: FastifyBaseLogger): Promise<Settings> {
  const missing = SETTING_KEYS.filter((key) => !cache.has(key));
  if (missing.length > 0) {
    const rows = await getPrisma().setting.findMany({ where: { key: { in: missing } } });
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    for (const key of missing) {
      const raw = stored.get(key);
      cache.set(
        key,
        raw === undefined ? registry[key].defaultValue() : decodeStoredValue(key, raw, log),
      );
    }
  }
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, cache.get(key)]),
  ) as unknown as Settings;
}

/**
 * Validates and persists a partial settings update (JSON-encoded upserts in
 * one transaction), refreshes the cache for the written keys and returns the
 * full updated settings. Unknown keys or invalid values throw a 400 ApiError.
 */
export async function setSettings(patch: SettingsPatch): Promise<Settings> {
  const result = settingsPatchSchema.safeParse(patch);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION', result.error.issues[0]?.message ?? 'Invalid settings');
  }

  const entries = Object.entries(result.data) as [SettingKey, Settings[SettingKey]][];
  const prisma = getPrisma();
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(value) },
        update: { value: JSON.stringify(value) },
      }),
    ),
  );

  // Write-through: subsequent reads (any route, same process) see the new
  // values immediately.
  for (const [key, value] of entries) cache.set(key, value);

  return getAllSettings();
}
