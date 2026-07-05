import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Server secrets persisted in `${CONFIG_DIR}/secrets.json`. */
export interface Secrets {
  /** HMAC secret used to sign JWT access tokens (64 hex chars = 256 bits). */
  jwtSecret: string;
  /** HMAC secret used to sign streaming tokens (64 hex chars = 256 bits). */
  streamTokenSecret: string;
}

/** Secret keys generated on demand; jwtSecret predates streamTokenSecret. */
const SECRET_KEYS = ['jwtSecret', 'streamTokenSecret'] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

export function secretsFilePath(configDir: string): string {
  return path.join(configDir, 'secrets.json');
}

function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Reads and validates the secrets file. Keys that are present must be valid;
 * a key that is absent entirely is reported as such so the caller can
 * generate and persist it (upgrade path for files written by older versions).
 * Unknown extra keys are preserved verbatim.
 */
function readSecretsFile(file: string): {
  raw: Record<string, unknown>;
  missing: SecretKey[];
} {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid secrets file at ${file}: expected a JSON object`);
  }
  const raw = parsed as Record<string, unknown>;

  const missing: SecretKey[] = [];
  for (const key of SECRET_KEYS) {
    if (!(key in raw)) {
      missing.push(key);
      continue;
    }
    const value = raw[key];
    if (typeof value !== 'string' || value.length < 32) {
      // Refuse to silently regenerate: that would invalidate every issued
      // token and could mask config-volume corruption. Operator decides.
      throw new Error(`Invalid secrets file at ${file}: malformed ${key}`);
    }
  }
  // jwtSecret has existed since the first release, so a file without it is
  // corruption rather than an old version — refuse, as above.
  if (missing.includes('jwtSecret')) {
    throw new Error(`Invalid secrets file at ${file}: missing or malformed jwtSecret`);
  }
  return { raw, missing };
}

function writeSecretsFile(file: string, secrets: Record<string, unknown>): void {
  writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode is filtered through the umask (and ignored entirely
  // when the file already exists); enforce 0600 exactly.
  chmodSync(file, 0o600);
}

/**
 * Loads the server secrets from `${configDir}/secrets.json`, generating and
 * persisting them (file mode 0600) on first boot. A file from an older
 * version that lacks newer keys (e.g. streamTokenSecret) has them generated
 * and appended in place, preserving every existing value. Secrets are never
 * logged and the file is never committed (the config dir is gitignored).
 */
export function loadOrCreateSecrets(configDir: string): Secrets {
  const file = secretsFilePath(configDir);

  const finishFromFile = ({
    raw,
    missing,
  }: {
    raw: Record<string, unknown>;
    missing: SecretKey[];
  }): Secrets => {
    if (missing.length > 0) {
      for (const key of missing) raw[key] = generateSecret();
      writeSecretsFile(file, raw);
    }
    return raw as unknown as Secrets;
  };

  try {
    return finishFromFile(readSecretsFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const secrets: Secrets = {
    jwtSecret: generateSecret(),
    streamTokenSecret: generateSecret(),
  };
  mkdirSync(configDir, { recursive: true });
  try {
    // 'wx' fails if the file appeared since the read above (concurrent boot).
    writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return finishFromFile(readSecretsFile(file));
    }
    throw err;
  }
  chmodSync(file, 0o600);
  return secrets;
}
