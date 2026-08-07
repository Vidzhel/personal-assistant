import type { DatabaseInterface } from '@raven/shared';

export type TopicScope = 'agent' | 'project';

export interface TopicRef {
  scope: TopicScope;
  key: string; // agent name or project id
  groupId: string;
}

export function getStoredTopic(db: DatabaseInterface, ref: TopicRef): number | undefined {
  const row = db.get<{ topic_id: number }>(
    'SELECT topic_id FROM telegram_topics WHERE scope = ? AND key = ? AND group_id = ?',
    ref.scope,
    ref.key,
    ref.groupId,
  );
  return row?.topic_id;
}

export function saveStoredTopic(db: DatabaseInterface, ref: TopicRef, topicId: number): void {
  db.run(
    `INSERT INTO telegram_topics (scope, key, group_id, topic_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, key, group_id) DO UPDATE SET topic_id = excluded.topic_id`,
    ref.scope,
    ref.key,
    ref.groupId,
    topicId,
  );
}

export function deleteStoredTopic(db: DatabaseInterface, ref: TopicRef): void {
  db.run(
    'DELETE FROM telegram_topics WHERE scope = ? AND key = ? AND group_id = ?',
    ref.scope,
    ref.key,
    ref.groupId,
  );
}
