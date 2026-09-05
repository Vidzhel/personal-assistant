CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  system_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  current_task_id TEXT
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  project_id TEXT,
  skill_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority TEXT NOT NULL DEFAULT 'normal',
  result TEXT,
  duration_ms INTEGER,
  errors TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  project_id TEXT,
  payload TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  task_type TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_budget_leases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  bucket_day TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  reservation_micro_usd INTEGER NOT NULL CHECK (reservation_micro_usd >= 0),
  actual_micro_usd INTEGER CHECK (actual_micro_usd IS NULL OR actual_micro_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'known', 'unknown', 'released')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_model_budget_leases_day_status
  ON model_budget_leases(bucket_day, status);
