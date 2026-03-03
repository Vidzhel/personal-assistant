import type { FastifyInstance } from 'fastify';
import { generateId } from '@raven/shared';
import type { ApiDeps } from '../server.ts';

export function registerScheduleRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/schedules', async () => {
    return deps.scheduler.getSchedules();
  });

  app.post<{
    Body: {
      name: string;
      cron: string;
      timezone?: string;
      taskType: string;
      skillName: string;
      enabled?: boolean;
    };
  }>('/api/schedules', async (req) => {
    const { name, cron, timezone, taskType, skillName, enabled } = req.body;
    const id = generateId();

    deps.scheduler.addSchedule({
      id,
      name,
      cron,
      timezone: timezone ?? 'UTC',
      taskType,
      skillName,
      enabled: enabled ?? true,
    });

    return { id, name, cron, taskType, skillName, enabled: enabled ?? true };
  });

  app.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req) => {
    deps.scheduler.removeSchedule(req.params.id);
    return { success: true };
  });
}
