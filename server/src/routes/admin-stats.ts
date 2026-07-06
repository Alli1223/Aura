import type { FastifyPluginAsync } from 'fastify';

import { getAdminStats } from '../lib/admin-stats.js';

// Admin-only server-wide statistics for the dashboard: total counts, storage per
// library, most-watched items, most-active users and recently-added counts.
// Read-only and admin-only (spans every user and library), mirroring the tasks
// route's [authenticate, requireAdmin] stance. Registered under /api/admin.

export const adminStatsRoutes: FastifyPluginAsync = async (app) => {
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  app.get('/stats', adminOnly, async () => getAdminStats());
};
