-- 030-tasks-add-scheduled-source.sql
-- Expand the source CHECK constraint on tasks to include 'scheduled'.
-- Also expands the status CHECK to match all TaskStatus values.
-- SQLite does not support ALTER COLUMN, so we recreate the table.

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'completed', 'archived', 'blocked', 'pending_approval')),
  assigned_agent_id TEXT,
  project_id TEXT,
  pipeline_id TEXT,
  schedule_id TEXT,
  parent_task_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'template', 'ticktick', 'pipeline', 'scheduled')),
  external_id TEXT,
  artifacts TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT INTO tasks_new SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent_id ON tasks(assigned_agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_external_id ON tasks(source, external_id);
CREATE INDEX IF NOT EXISTS idx_tasks_schedule_id ON tasks(schedule_id);
