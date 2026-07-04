import type { FastifyPluginAsync } from 'fastify';

import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { getAllSettings, getSetting, setSettings, settingsPatchSchema } from '../lib/settings.js';
import { parseBody } from '../lib/validation.js';

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // All settings with typed values. Admin-only: settings like baseUrl and
  // transcodeDir describe server internals and must not leak to users.
  app.get('/', adminOnly, async (request) => ({
    settings: await getAllSettings(request.log),
  }));

  // Partial update. Strict validation (unknown keys 400) happens in
  // settingsPatchSchema; setSettings re-validates and upserts atomically.
  app.patch('/', adminOnly, async (request, reply) => {
    const patch = parseBody(settingsPatchSchema, request.body, reply);
    if (patch === undefined) return reply;

    const settings = await setSettings(patch);

    // None of the current settings are secret, so new values are auditable.
    // Revisit before adding secret-valued settings (log key names only).
    await writeAuditLog(
      prisma,
      {
        action: 'settings.updated',
        userId: request.user.id,
        ip: request.ip,
        details: { changed: patch },
      },
      request.log,
    );

    return reply.send({ settings });
  });

  // Unauthenticated: the login/register pages need the server name and
  // whether registration is open BEFORE the user has a session. Exposes
  // exactly these two values and nothing else.
  app.get('/public', async (request) => ({
    serverName: await getSetting('serverName', request.log),
    registrationEnabled: await getSetting('registrationEnabled', request.log),
  }));
};
