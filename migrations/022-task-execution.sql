-- Task execution engine tables

CREATE TABLE IF NOT EXISTS execution_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  node_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('pending_approval', 'todo', 'ready', 'in_progress', 'validating', 'completed', 'failed', 'blocked', 'skipped', 'cancelled')),
  agent_task_id TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  needs_replan INTEGER NOT NULL DEFAULT 0,
  validation_result_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_tasks_parent ON execution_tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_execution_tasks_status ON execution_tasks(status);

CREATE TABLE IF NOT EXISTS task_trees (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'running', 'completed', 'failed', 'cancelled')),
  plan TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
