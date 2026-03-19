import type { FastifyInstance } from 'fastify';
import { generateId, HTTP_STATUS } from '@raven/shared';
import type { ApiDeps } from '../server.ts';

// eslint-disable-next-line max-lines-per-function -- includes trigger endpoint
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

  app.post<{ Params: { id: string } }>('/api/schedules/:id/trigger', async (req, reply) => {
    const schedules = deps.scheduler.getSchedules();
    const schedule = schedules.find((s) => s.id === req.params.id);
    if (!schedule) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Schedule not found' });
    }
    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'scheduler',
      type: 'schedule:triggered',
      payload: {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        taskType: schedule.taskType,
      },
    });
    return { triggered: true };
  });
}
