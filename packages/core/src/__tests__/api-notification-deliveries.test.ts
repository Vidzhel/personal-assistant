import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerNotificationPreferencesRoutes } from '../api/routes/notification-preferences.ts';
import { enqueueNotification } from '../notification-engine/notification-queue.ts';
import { createTestDb } from './services/notifications/helpers/test-db.ts';

describe('notification delivery diagnostics API', () => {
  it('returns sanitized evidence with stable project id and friendly name', async () => {
    const db = createTestDb();
    db.run(
      `INSERT INTO projects (id, name, skills, created_at, updated_at)
       VALUES ('project-id', 'Friendly Project', '[]', 1, 1)`,
    );
    const id = enqueueNotification(db, {
      source: 'test-source',
      title: 'Delivery title',
      body: 'private body excluded by route',
      channel: 'telegram',
      destination: { kind: 'project', projectId: 'project-id' },
      urgencyTier: 'green',
      deliveryMode: 'tell-now',
      status: 'pending',
    });
    db.run(
      `UPDATE notification_queue
       SET status = 'failed', attempt_count = 1, last_error = 'provider rejected'
       WHERE id = ?`,
      id,
    );
    const app = Fastify();
    registerNotificationPreferencesRoutes(app, { db });

    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/deliveries?limit=1',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.deliveries[0]).toMatchObject({
      id,
      source: 'test-source',
      title: 'Delivery title',
      status: 'failed',
      destination: {
        kind: 'project',
        projectId: 'project-id',
        projectName: 'Friendly Project',
      },
      attemptCount: 1,
      lastError: 'provider rejected',
    });
    expect(payload.deliveries[0]).not.toHaveProperty('body');
    await app.close();
  });

  it('rejects fractional limits and excludes non-Telegram queue rows', async () => {
    const db = createTestDb();
    enqueueNotification(db, {
      source: 'web-only',
      title: 'Browser notice',
      body: 'Not Telegram evidence',
      channel: 'web',
      destination: { kind: 'global', topic: 'general' },
      urgencyTier: 'green',
      deliveryMode: 'tell-now',
      status: 'pending',
    });
    const app = Fastify();
    registerNotificationPreferencesRoutes(app, { db });

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/notifications/deliveries?limit=1.5',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'limit must be a positive integer' });

    const valid = await app.inject({
      method: 'GET',
      url: '/api/notifications/deliveries',
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ deliveries: [] });
    await app.close();
  });
});
