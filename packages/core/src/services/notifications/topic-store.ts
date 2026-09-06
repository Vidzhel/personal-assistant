import type { DatabaseInterface } from '@raven/shared';

export interface ProjectTopicRef {
  projectId: string;
  groupId: string;
}

export interface StoredTopic extends ProjectTopicRef {
  topicId: number;
}

export function getStoredTopic(db: DatabaseInterface, ref: ProjectTopicRef): number | undefined {
  const row = db.get<{ topic_id: number }>(
    'SELECT topic_id FROM telegram_topics WHERE project_id = ? AND group_id = ?',
    ref.projectId,
    ref.groupId,
  );
  return row?.topic_id;
}

export function saveStoredTopic(
  db: DatabaseInterface,
  ref: ProjectTopicRef,
  topicId: number,
): void {
  db.run(
    `INSERT INTO telegram_topics (project_id, group_id, topic_id) VALUES (?, ?, ?)
     ON CONFLICT(project_id, group_id) DO UPDATE SET topic_id = excluded.topic_id`,
    ref.projectId,
    ref.groupId,
    topicId,
  );
}

export function deleteStoredTopic(db: DatabaseInterface, ref: ProjectTopicRef): void {
  db.run(
    'DELETE FROM telegram_topics WHERE project_id = ? AND group_id = ?',
    ref.projectId,
    ref.groupId,
  );
}

export function getStoredProjectForTopic(
  db: DatabaseInterface,
  groupId: string,
  topicId: number,
): string | undefined {
  return db.get<{ key: string }>(
    'SELECT project_id AS key FROM telegram_topics WHERE group_id = ? AND topic_id = ?',
    groupId,
    topicId,
  )?.key;
}

export function listStoredProjectTopics(db: DatabaseInterface, groupId: string): StoredTopic[] {
  return db
    .all<{ key: string; topic_id: number }>(
      'SELECT project_id AS key, topic_id FROM telegram_topics WHERE group_id = ?',
      groupId,
    )
    .map((row) => ({ projectId: row.key, groupId, topicId: row.topic_id }));
}

export function bindProjectTopic(
  db: DatabaseInterface,
  binding: { groupId: string; topicId: number; projectId: string },
): void {
  const { groupId, topicId, projectId } = binding;
  db.run(
    'DELETE FROM telegram_topics WHERE group_id = ? AND topic_id = ? AND project_id <> ?',
    groupId,
    topicId,
    projectId,
  );
  saveStoredTopic(db, { projectId, groupId }, topicId);
}
