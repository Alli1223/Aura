import { existsSync } from 'node:fs';
import path from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';

import { healthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  /**
   * Directory containing the built web app (index.html + assets). When it
   * exists it is served as the static root with an SPA fallback; when it
   * doesn't (development, tests) the server is API-only.
   */
  webDistDir?: string;
}

export function buildApp(
  options: FastifyServerOptions = {},
  { webDistDir }: BuildAppOptions = {},
): FastifyInstance {
  const app = Fastify(options);

  void app.register(cookie);
  // Strict default: no cross-origin access. The web app is served same-origin
  // (Vite dev proxy in development, static files from this server in production).
  void app.register(cors, { origin: false });

  void app.register(healthRoutes, { prefix: '/api' });

  if (webDistDir !== undefined && existsSync(webDistDir)) {
    const root = path.resolve(webDistDir);
    void app.register(fastifyStatic, { root });

    // SPA fallback: unknown non-API GET routes get index.html so client-side
    // routing works. API routes keep Fastify's default JSON 404 shape.
    app.setNotFoundHandler(async (request, reply) => {
      const isApiRoute = request.url === '/api' || request.url.startsWith('/api/');
      if (request.method === 'GET' && !isApiRoute) {
        return reply.type('text/html; charset=utf-8').sendFile('index.html');
      }
      return reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
    });
  }

  return app;
}
