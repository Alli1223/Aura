import type { FullConfig } from '@playwright/test';

// Global setup: block until the target Aura instance is healthy before any spec
// runs. In CI the container has just been started; this absorbs the boot +
// `prisma migrate deploy` window so specs never race the server coming up.

const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

function resolveBaseURL(config: FullConfig): string {
  const fromEnv = process.env.E2E_BASE_URL;
  const fromConfig = config.projects[0]?.use?.baseURL;
  return (fromEnv ?? fromConfig ?? 'http://localhost:8096').replace(/\/$/, '');
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = resolveBaseURL(config);
  const healthUrl = `${baseURL}/api/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  for (;;) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === 'ok') {
          console.log(`e2e: server healthy at ${healthUrl}`);
          return;
        }
      }
    } catch {
      // Server not accepting connections yet — keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `e2e: server did not become healthy at ${healthUrl} within ${HEALTH_TIMEOUT_MS}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
