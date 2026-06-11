CREATE TABLE IF NOT EXISTS telegram_topics (
  scope TEXT NOT NULL CHECK (scope IN ('agent', 'project')),
  key TEXT NOT NULL,
  group_id TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, key, group_id)
);
