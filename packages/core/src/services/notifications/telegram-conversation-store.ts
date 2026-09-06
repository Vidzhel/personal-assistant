import type { DatabaseInterface } from '@raven/shared';

export interface TelegramConversation {
  chatId: string;
  topicId?: number;
  projectId: string;
  sessionId?: string;
  revision?: number;
}

export interface TelegramMessageBinding extends TelegramConversation {
  messageId: number;
  requestId?: string;
  taskId?: string;
  direction: 'incoming' | 'outgoing';
}

const normalizedTopic = (topicId: number | undefined): number => topicId ?? 0;

export function getTelegramConversation(
  db: DatabaseInterface,
  chatId: string,
  topicId?: number,
): TelegramConversation | undefined {
  const row = db.get<{ project_id: string; session_id: string | null; revision: number }>(
    'SELECT project_id, session_id, revision FROM telegram_conversations WHERE chat_id = ? AND topic_id = ?',
    chatId,
    normalizedTopic(topicId),
  );
  return row
    ? {
        chatId,
        topicId,
        projectId: row.project_id,
        sessionId: row.session_id ?? undefined,
        revision: row.revision,
      }
    : undefined;
}

export function saveTelegramConversation(
  db: DatabaseInterface,
  conversation: TelegramConversation,
): void {
  db.run(
    `INSERT INTO telegram_conversations
       (chat_id, topic_id, project_id, session_id, revision, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(chat_id, topic_id) DO UPDATE SET
       project_id = excluded.project_id,
       session_id = excluded.session_id,
       revision = telegram_conversations.revision + 1,
       updated_at = excluded.updated_at`,
    conversation.chatId,
    normalizedTopic(conversation.topicId),
    conversation.projectId,
    conversation.sessionId ?? null,
    new Date().toISOString(),
  );
}

export function ensureTelegramConversation(
  db: DatabaseInterface,
  conversation: TelegramConversation,
): TelegramConversation {
  db.run(
    `INSERT OR IGNORE INTO telegram_conversations
       (chat_id, topic_id, project_id, session_id, revision, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    conversation.chatId,
    normalizedTopic(conversation.topicId),
    conversation.projectId,
    conversation.sessionId ?? null,
    new Date().toISOString(),
  );
  const stored = getTelegramConversation(db, conversation.chatId, conversation.topicId);
  if (!stored) throw new Error('Telegram conversation could not be initialized');
  return stored;
}

export function saveTelegramConversationIfRevision(
  db: DatabaseInterface,
  conversation: TelegramConversation,
  expectedRevision: number,
): boolean {
  db.run(
    `UPDATE telegram_conversations
     SET project_id = ?, session_id = ?, revision = revision + 1, updated_at = ?
     WHERE chat_id = ? AND topic_id = ? AND revision = ?`,
    conversation.projectId,
    conversation.sessionId ?? null,
    new Date().toISOString(),
    conversation.chatId,
    normalizedTopic(conversation.topicId),
    expectedRevision,
  );
  return db.get<{ changed: number }>('SELECT changes() AS changed')?.changed === 1;
}

export function getTelegramMessageBinding(
  db: DatabaseInterface,
  chatId: string,
  messageId: number,
): TelegramMessageBinding | undefined {
  const row = db.get<{
    topic_id: number | null;
    project_id: string;
    session_id: string | null;
    request_id: string | null;
    task_id: string | null;
    direction: 'incoming' | 'outgoing';
  }>(
    `SELECT topic_id, project_id, session_id, request_id, task_id, direction
     FROM telegram_message_bindings WHERE chat_id = ? AND message_id = ?`,
    chatId,
    messageId,
  );
  return row
    ? {
        chatId,
        messageId,
        topicId: row.topic_id ?? undefined,
        projectId: row.project_id,
        sessionId: row.session_id ?? undefined,
        requestId: row.request_id ?? undefined,
        taskId: row.task_id ?? undefined,
        direction: row.direction,
      }
    : undefined;
}

export function saveTelegramMessageBinding(
  db: DatabaseInterface,
  binding: TelegramMessageBinding,
): void {
  db.run(
    `INSERT INTO telegram_message_bindings
       (chat_id, message_id, topic_id, project_id, session_id, request_id, task_id, direction, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET
       topic_id = excluded.topic_id,
       project_id = excluded.project_id,
       session_id = excluded.session_id,
       request_id = excluded.request_id,
       task_id = excluded.task_id,
       direction = excluded.direction`,
    binding.chatId,
    binding.messageId,
    binding.topicId ?? null,
    binding.projectId,
    binding.sessionId ?? null,
    binding.requestId ?? null,
    binding.taskId ?? null,
    binding.direction,
    new Date().toISOString(),
  );
}

export function deleteTelegramIncomingBinding(
  db: DatabaseInterface,
  params: { chatId: string; messageId: number; requestId: string },
): void {
  db.run(
    `DELETE FROM telegram_message_bindings
     WHERE chat_id = ? AND message_id = ? AND request_id = ? AND direction = 'incoming'`,
    params.chatId,
    params.messageId,
    params.requestId,
  );
}
