import { PrismaClient } from '@prisma/client';

// Lazy singleton so importing this module has no side effects and tests can
// point DATABASE_URL at a temporary database before the client is created.
let client: PrismaClient | null = null;

/**
 * Returns the shared PrismaClient instance, creating it on first use.
 * The connection string is read from the DATABASE_URL environment variable.
 */
export function getPrisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

/**
 * Gracefully disconnects the shared client (no-op if never created).
 * Call on server shutdown.
 */
export async function disconnectPrisma(): Promise<void> {
  if (client !== null) {
    const current = client;
    client = null;
    await current.$disconnect();
  }
}
