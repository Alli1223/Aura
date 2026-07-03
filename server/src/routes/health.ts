import type { FastifyInstance } from 'fastify';

import { appVersion } from '../version.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', version: appVersion }));
}
