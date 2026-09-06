import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseInterface } from '@raven/shared';
import {
  getActiveSnoozes,
  createSnooze,
  removeSnooze,
} from '../../notification-engine/snooze-store.ts';
import {
  getSnoozedByCategory,
  listDeliveryDiagnostics,
  releaseSnoozed,
} from '../../notification-engine/notification-queue.ts';
import { matchesPattern } from '../../notification-engine/urgency-classifier.ts';

export interface NotificationPreferencesDeps {
  db: DatabaseInterface;
  unsnoozableCategories?: string[];
}

const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;
const HTTP_NOT_FOUND = 404;
const DEFAULT_DELIVERY_LIMIT = 100;

const VALID_DURATIONS = ['1h', '1d', '1w', 'mute'] as const;

type SnoozeDuration = (typeof VALID_DURATIONS)[number];

function deliveryDestination(
  item: ReturnType<typeof listDeliveryDiagnostics>[number],
):
  | { kind: 'project'; projectId: string | null; projectName: string | null }
  | { kind: 'global'; topic: string | null }
  | null {
  if (item.destinationKind === 'project') {
    return {
      kind: 'project',
      projectId: item.destinationProjectId,
      projectName: item.destinationProjectName,
    };
  }
  if (item.destinationKind === 'global') {
    return { kind: 'global' as const, topic: item.destinationTopic };
  }
  return null;
}

function registerDeliveryRoutes(app: FastifyInstance, db: DatabaseInterface): void {
  app.get<{ Querystring: { limit?: string } }>(
    '/api/notifications/deliveries',
    async (request, reply) => {
      const requested = Number(request.query.limit ?? DEFAULT_DELIVERY_LIMIT);
      if (!Number.isInteger(requested) || requested < 1) {
        return reply.status(HTTP_BAD_REQUEST).send({ error: 'limit must be a positive integer' });
      }
      return {
        deliveries: listDeliveryDiagnostics(db, requested).map((item) => ({
          id: item.id,
          source: item.source,
          title: item.title,
          channel: item.channel,
          status: item.status,
          destination: deliveryDestination(item),
          attemptCount: item.attemptCount,
          providerMessageId: item.providerMessageId,
          lastError: item.lastError,
          lastAttemptAt: item.lastAttemptAt,
          createdAt: item.createdAt,
          deliveredAt: item.deliveredAt,
        })),
      };
    },
  );
}

function handleCreateSnooze(
  body: { category: string; duration: string },
  deps: { db: DatabaseInterface; reply: FastifyReply; unsnoozableCategories: string[] },
): ReturnType<FastifyReply['send']> {
  const { db, reply, unsnoozableCategories } = deps;
  const { category, duration } = body;

  if (!category || !duration) {
    return reply.status(HTTP_BAD_REQUEST).send({ error: 'category and duration are required' });
  }

  if (!VALID_DURATIONS.includes(duration as SnoozeDuration)) {
    return reply
      .status(HTTP_BAD_REQUEST)
      .send({ error: `duration must be one of: ${VALID_DURATIONS.join(', ')}` });
  }

  const isUnsnoozable = unsnoozableCategories.some(
    (pattern) => matchesPattern(category, pattern) || matchesPattern(pattern, category),
  );
  if (isUnsnoozable) {
    return reply.status(HTTP_BAD_REQUEST).send({ error: 'Category is unsnoozable' });
  }

  const record = createSnooze(db, { category, duration: duration as SnoozeDuration });
  return reply.status(HTTP_CREATED).send({
    id: record.id,
    category: record.category,
    duration,
    snoozedUntil: record.snoozedUntil,
    heldCount: record.heldCount,
  });
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
  registerDeliveryRoutes(app, deps.db);

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
    return handleCreateSnooze(request.body, {
      db: deps.db,
      reply,
      unsnoozableCategories: deps.unsnoozableCategories ?? [],
    });
  });

  app.delete<{
    Params: { id: string };
  }>('/api/notifications/snooze/:id', async (request, reply) => {
    return handleDeleteSnooze(request.params.id, deps.db, reply);
  });
}
