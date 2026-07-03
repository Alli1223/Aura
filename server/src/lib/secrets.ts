import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Server secrets persisted in `${CONFIG_DIR}/secrets.json`. */
export interface Secrets {
  /** HMAC secret used to sign JWT access tokens (64 hex chars = 256 bits). */
  jwtSecret: string;
}

export function secretsFilePath(configDir: string): string {
  return path.join(configDir, 'secrets.json');
}

function readSecretsFile(file: string): Secrets {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const jwtSecret =
    typeof parsed === 'object' && parsed !== null && 'jwtSecret' in parsed
      ? (parsed as { jwtSecret: unknown }).jwtSecret
      : undefined;
  if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) {
    // Refuse to silently regenerate: that would invalidate every issued token
    // and could mask config-volume corruption. Make the operator decide.
    throw new Error(`Invalid secrets file at ${file}: missing or malformed jwtSecret`);
  }
  return { jwtSecret };
}

/**
 * Loads the server secrets from `${configDir}/secrets.json`, generating and
 * persisting them (file mode 0600) on first boot. Secrets are never logged
 * and the file is never committed (the config dir is gitignored).
 */
export function loadOrCreateSecrets(configDir: string): Secrets {
  const file = secretsFilePath(configDir);
  try {
    return readSecretsFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const secrets: Secrets = { jwtSecret: randomBytes(32).toString('hex') };
  mkdirSync(configDir, { recursive: true });
  try {
    // 'wx' fails if the file appeared since the read above (concurrent boot).
    writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readSecretsFile(file);
    throw err;
  }
  // writeFileSync's mode is filtered through the umask; enforce 0600 exactly.
  chmodSync(file, 0o600);
  return secrets;
}
