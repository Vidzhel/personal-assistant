import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseInterface } from '@raven/shared';
import {
  getActiveSnoozes,
  createSnooze,
  removeSnooze,
} from '../../notification-engine/snooze-store.ts';
import {
  getSnoozedByCategory,
  releaseSnoozed,
} from '../../notification-engine/notification-queue.ts';

export interface NotificationPreferencesDeps {
  db: DatabaseInterface;
}

const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;
const HTTP_NOT_FOUND = 404;

const VALID_DURATIONS = ['1h', '1d', '1w', 'mute'] as const;

type SnoozeDuration = (typeof VALID_DURATIONS)[number];

function handleCreateSnooze(
  body: { category: string; duration: string },
  db: DatabaseInterface,
  reply: FastifyReply,
): ReturnType<FastifyReply['send']> {
  const { category, duration } = body;

  if (!category || !duration) {
    return reply.status(HTTP_BAD_REQUEST).send({ error: 'category and duration are required' });
  }

  if (!VALID_DURATIONS.includes(duration as SnoozeDuration)) {
    return reply
      .status(HTTP_BAD_REQUEST)
      .send({ error: `duration must be one of: ${VALID_DURATIONS.join(', ')}` });
  }

  const id = createSnooze(db, { category, duration: duration as SnoozeDuration });
  return reply.status(HTTP_CREATED).send({ id, category, duration });
}

function handleDeleteSnooze(
  id: string,
  db: DatabaseInterface,
  reply: FastifyReply,
): ReturnType<FastifyReply['send']> {
  const snoozes = getActiveSnoozes(db);
  const snooze = snoozes.find((s) => s.id === id);

  const removed = removeSnooze(db, id);
  if (!removed) {
    return reply.status(HTTP_NOT_FOUND).send({ error: 'Snooze not found' });
  }

  if (snooze) {
    const snoozed = getSnoozedByCategory(db, snooze.category);
    if (snoozed.length > 0) {
      releaseSnoozed(
        db,
        snoozed.map((n) => n.id),
      );
    }
  }

  return reply.send({ success: true, releasedCount: snooze ? snooze.heldCount : 0 });
}

export function registerNotificationPreferencesRoutes(
  app: FastifyInstance,
  deps: NotificationPreferencesDeps,
): void {
  app.get('/api/notifications/snooze', async () => {
    const snoozes = getActiveSnoozes(deps.db);
    return {
      snoozes: snoozes.map((s) => ({
        id: s.id,
        category: s.category,
        snoozedUntil: s.snoozedUntil,
        heldCount: s.heldCount,
        createdAt: s.createdAt,
      })),
    };
  });

  app.post<{
    Body: { category: string; duration: string };
  }>('/api/notifications/snooze', async (request, reply) => {
    return handleCreateSnooze(request.body, deps.db, reply);
  });

  app.delete<{
    Params: { id: string };
  }>('/api/notifications/snooze/:id', async (request, reply) => {
    return handleDeleteSnooze(request.params.id, deps.db, reply);
  });
}
