import { randomUUID } from 'node:crypto';

import argon2 from 'argon2';

// OWASP-recommended argon2id parameters (19 MiB memory, 2 iterations,
// 1 lane). Bump memoryCost/timeCost together if hardware allows.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** Returns false (never throws) for wrong passwords or malformed hashes. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | undefined;

/**
 * A hash of a random unguessable value, used to burn a verification on login
 * attempts for unknown usernames so response timing does not reveal whether
 * the username exists.
 */
export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomUUID());
  return dummyHashPromise;
}
