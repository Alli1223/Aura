import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

import { healthRoutes } from './routes/health.js';

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  void app.register(cookie);
  // Strict default: no cross-origin access. The web app is served same-origin
  // (Vite dev proxy in development, static files from this server in production).
  void app.register(cors, { origin: false });

  void app.register(healthRoutes, { prefix: '/api' });

  return app;
}
