import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getPrisma } from '../db/client.js';
import { writeAuditLog } from '../lib/audit.js';
import { sendError } from '../lib/errors.js';
import { parseParams } from '../lib/validation.js';
import {
  getActiveTaskRunner,
  TaskAlreadyRunningError,
  UnknownTaskError,
} from '../tasks/task-runner.js';

// Admin-only scheduled-task status + trigger API. Task state (paths, backup
// results, error messages) is server-maintenance detail, so both routes are
// admin-only, mirroring the scan routes.

const taskIdParamsSchema = z.object({ id: z.string().min(1, 'Task id is required') });

export const tasksRoutes: FastifyPluginAsync = async (app) => {
  const prisma = getPrisma();
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };

  // Status of every registered task. Empty when no runner is installed
  // (e.g. TASKS_ENABLED never built one in this process).
  app.get('/', adminOnly, async () => {
    const runner = getActiveTaskRunner();
    return { tasks: runner?.getStatuses() ?? [] };
  });

  // Trigger a task now. 202 on start, 404 for an unknown id, 409 when it is
  // already running. The run itself is fire-and-forget (its outcome is read
  // back via GET /api/tasks).
  app.post('/:id/run', adminOnly, async (request, reply) => {
    const params = parseParams(taskIdParamsSchema, request.params, reply);
    if (params === undefined) return reply;

    const runner = getActiveTaskRunner();
    if (runner === null || !runner.has(params.id)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Unknown task');
    }

    try {
      // Kicks the run off; the returned promise never rejects (task failures
      // are captured into status), so voiding it cannot leak an error.
      void runner.runNow(params.id);
    } catch (err) {
      if (err instanceof TaskAlreadyRunningError) {
        return sendError(reply, 409, 'TASK_RUNNING', 'Task is already running');
      }
      if (err instanceof UnknownTaskError) {
        return sendError(reply, 404, 'NOT_FOUND', 'Unknown task');
      }
      throw err;
    }

    await writeAuditLog(
      prisma,
      {
        action: 'task.triggered',
        userId: request.user.id,
        targetType: 'task',
        targetId: params.id,
        ip: request.ip,
      },
      request.log,
    );

    return reply.status(202).send({ started: true, taskId: params.id });
  });
};
