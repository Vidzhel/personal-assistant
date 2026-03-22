-- 015-tasks.sql: Advanced Task Management System
-- User-facing task layer above the existing agent_tasks execution layer

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'completed', 'archived')),
  assigned_agent_id TEXT,
  project_id TEXT,
  pipeline_id TEXT,
  schedule_id TEXT,
  parent_task_id TEXT REFERENCES tasks(id),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'template', 'ticktick', 'pipeline')),
  external_id TEXT,
  artifacts TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent_id ON tasks(assigned_agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_external_id ON tasks(source, external_id);
