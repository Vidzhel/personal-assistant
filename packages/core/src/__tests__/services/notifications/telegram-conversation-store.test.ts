import { describe, expect, it } from 'vitest';
import {
  getTelegramConversation,
  getTelegramMessageBinding,
  saveTelegramConversation,
  saveTelegramConversationIfRevision,
  saveTelegramMessageBinding,
} from '../../../services/notifications/telegram-conversation-store.ts';
import { createTestDb } from './helpers/test-db.ts';

describe('telegram-conversation-store', () => {
  it('keeps direct and topic conversations separate by stable project id', () => {
    const db = createTestDb();
    saveTelegramConversation(db, {
      chatId: '123',
      projectId: 'telegram-default',
      sessionId: 'inbox-session',
    });
    saveTelegramConversation(db, {
      chatId: '-1001',
      topicId: 42,
      projectId: 'project-id',
      sessionId: 'project-session',
    });

    expect(getTelegramConversation(db, '123')).toMatchObject({
      projectId: 'telegram-default',
      sessionId: 'inbox-session',
    });
    expect(getTelegramConversation(db, '-1001', 42)).toMatchObject({
      topicId: 42,
      projectId: 'project-id',
      sessionId: 'project-session',
    });
  });

  it('persists outgoing reply identity for restart-safe session routing', () => {
    const db = createTestDb();
    saveTelegramMessageBinding(db, {
      chatId: '-1001',
      messageId: 900,
      topicId: 42,
      projectId: 'project-id',
      sessionId: 'project-session',
      taskId: 'task-id',
      direction: 'outgoing',
    });

    expect(getTelegramMessageBinding(db, '-1001', 900)).toEqual({
      chatId: '-1001',
      messageId: 900,
      topicId: 42,
      projectId: 'project-id',
      sessionId: 'project-session',
      taskId: 'task-id',
      direction: 'outgoing',
    });
  });

  it('updates the selected session without losing the conversation address', () => {
    const db = createTestDb();
    saveTelegramConversation(db, {
      chatId: '-1001',
      topicId: 42,
      projectId: 'project-id',
      sessionId: 'old-session',
    });
    saveTelegramConversation(db, {
      chatId: '-1001',
      topicId: 42,
      projectId: 'project-id',
      sessionId: 'new-session',
    });

    expect(getTelegramConversation(db, '-1001', 42)?.sessionId).toBe('new-session');
  });

  it('keeps a newer selection when an older accepted request arrives late', () => {
    const db = createTestDb();
    saveTelegramConversation(db, {
      chatId: '123',
      projectId: 'project-a',
      sessionId: 'old-session',
    });
    const admittedRevision = getTelegramConversation(db, '123')!.revision!;
    saveTelegramConversation(db, {
      chatId: '123',
      projectId: 'project-b',
      sessionId: 'new-session',
    });

    expect(
      saveTelegramConversationIfRevision(
        db,
        { chatId: '123', projectId: 'project-a', sessionId: 'accepted-session' },
        admittedRevision,
      ),
    ).toBe(false);
    expect(getTelegramConversation(db, '123')).toMatchObject({
      projectId: 'project-b',
      sessionId: 'new-session',
      revision: admittedRevision + 1,
    });
  });

  it('allows a pending incoming binding without a selected session', () => {
    const db = createTestDb();
    expect(() =>
      saveTelegramMessageBinding(db, {
        chatId: '123',
        messageId: 1,
        projectId: 'telegram-default',
        requestId: 'request-one',
        direction: 'incoming',
      }),
    ).not.toThrow();
    expect(getTelegramMessageBinding(db, '123', 1)?.sessionId).toBeUndefined();
  });
});
