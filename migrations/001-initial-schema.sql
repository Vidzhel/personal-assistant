-- Consolidated fresh Raven operational schema.
-- The migration runner owns _migrations bookkeeping.

PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  system_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  system_access TEXT NOT NULL DEFAULT 'none',
  is_meta INTEGER NOT NULL DEFAULT 0,
  fs_path TEXT
);
CREATE UNIQUE INDEX idx_projects_fs_path
  ON projects(fs_path) WHERE fs_path IS NOT NULL;
CREATE INDEX idx_projects_is_meta ON projects(is_meta);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  sdk_session_id TEXT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'idle',
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  current_task_id TEXT,
  name TEXT,
  description TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);
CREATE INDEX idx_sessions_pinned ON sessions(pinned);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  project_id TEXT,
  payload TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_timestamp ON events(timestamp);

CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE model_budget_leases (
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
CREATE INDEX idx_model_budget_leases_day_status
  ON model_budget_leases(bucket_day, status);

CREATE TABLE gemini_uploads (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  project_id TEXT,
  source_file_path TEXT NOT NULL,
  remote_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'active', 'pending_delete', 'unknown', 'deleted')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_gemini_uploads_status_created
  ON gemini_uploads(status, created_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  action_name TEXT NOT NULL,
  permission_tier TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details TEXT,
  session_id TEXT
);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_log_skill_name ON audit_log(skill_name);
CREATE INDEX idx_audit_log_outcome ON audit_log(outcome);

CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  details TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  session_id TEXT
);
CREATE INDEX idx_pending_approvals_resolution ON pending_approvals(resolution);

CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  pattern_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  service_sources TEXT NOT NULL,
  suppression_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  dismissed_at TEXT
);
CREATE INDEX idx_insights_status ON insights(status);
CREATE INDEX idx_insights_pattern_key ON insights(pattern_key);
CREATE INDEX idx_insights_suppression_hash ON insights(suppression_hash);
CREATE INDEX idx_insights_created_at ON insights(created_at);

CREATE TABLE notification_queue (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  topic_name TEXT,
  actions_json TEXT,
  channel TEXT,
  urgency_tier TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  scheduled_for TEXT,
  delivered_at TEXT
);
CREATE INDEX idx_notification_queue_status ON notification_queue(status);
CREATE INDEX idx_notification_queue_delivery_mode ON notification_queue(delivery_mode);
CREATE INDEX idx_notification_queue_scheduled_for ON notification_queue(scheduled_for);

CREATE TABLE engagement_metrics (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  notification_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_engagement_created ON engagement_metrics(created_at);
CREATE INDEX idx_engagement_type ON engagement_metrics(event_type);
CREATE INDEX idx_engagement_notification ON engagement_metrics(notification_id);

CREATE TABLE notification_snooze (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  snoozed_until TEXT,
  held_count INTEGER NOT NULL DEFAULT 0,
  last_suggested_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_snooze_category ON notification_snooze(category);

CREATE TABLE snooze_suggestions (
  category TEXT PRIMARY KEY,
  suggested_at TEXT NOT NULL
);

CREATE TABLE financial_accounts (
  id TEXT PRIMARY KEY,
  bank TEXT NOT NULL CHECK (bank IN ('monobank', 'privatbank')),
  bank_account_id TEXT NOT NULL,
  iban TEXT,
  currency_code INTEGER NOT NULL DEFAULT 980,
  display_name TEXT NOT NULL,
  ynab_account_id TEXT,
  ynab_server_knowledge INTEGER DEFAULT 0,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE financial_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  bank_tx_id TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL,
  currency_code INTEGER NOT NULL DEFAULT 980,
  description TEXT NOT NULL DEFAULT '',
  mcc INTEGER,
  ynab_category TEXT,
  ynab_transaction_id TEXT,
  is_debit INTEGER NOT NULL DEFAULT 1,
  balance_after_minor INTEGER,
  transaction_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_financial_tx_account_date
  ON financial_transactions(account_id, transaction_date);

CREATE TABLE cross_domain_thresholds (
  domain_pair TEXT PRIMARY KEY,
  threshold REAL NOT NULL DEFAULT 0.75,
  dismissal_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE cross_domain_dismissals (
  id TEXT PRIMARY KEY,
  insight_id TEXT NOT NULL,
  domain_pair TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE session_references (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  target_session_id TEXT NOT NULL REFERENCES sessions(id),
  context TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_references_source ON session_references(source_session_id);
CREATE INDEX idx_session_references_target ON session_references(target_session_id);

CREATE TABLE project_data_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  uri TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('gdrive', 'file', 'url', 'other')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_data_sources_project ON project_data_sources(project_id);

CREATE TABLE knowledge_rejections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_knowledge_rejections_lookup
  ON knowledge_rejections(project_id, content_hash);

CREATE TABLE telegram_topics (
  scope TEXT NOT NULL CHECK (scope IN ('agent', 'project')),
  key TEXT NOT NULL,
  group_id TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, key, group_id)
);

CREATE TABLE schedule_fires (
  id TEXT PRIMARY KEY,
  schedule_name TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  activation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'blocked', 'fired', 'failed')),
  detail TEXT
);
CREATE INDEX idx_schedule_fires_schedule_name ON schedule_fires(schedule_name);
CREATE INDEX idx_schedule_fires_fired_at ON schedule_fires(fired_at);
CREATE INDEX idx_schedule_fires_activation
  ON schedule_fires(schedule_name, activation_id, fired_at);

CREATE TABLE self_test_results (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  violations_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_self_test_results_ran_at ON self_test_results(ran_at);

CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'time')),
  pattern TEXT NOT NULL DEFAULT '[]',
  event_types TEXT NOT NULL DEFAULT '[]',
  message TEXT NOT NULL,
  next_fire_at INTEGER,
  fire_budget INTEGER NOT NULL DEFAULT 3,
  fires_used INTEGER NOT NULL DEFAULT 0,
  cooldown_hours INTEGER NOT NULL DEFAULT 24,
  last_fired_at INTEGER,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'expired', 'cancelled')),
  created_at INTEGER NOT NULL,
  source_session TEXT
);
CREATE INDEX idx_intents_status ON intents(status);
CREATE INDEX idx_intents_kind_status ON intents(kind, status);

INSERT INTO projects (
  id, name, description, skills, system_prompt, system_access, is_meta, created_at, updated_at
) VALUES (
  'meta', 'Raven System', 'System management and administration', '[]', '',
  'read-write', 1, strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000
);
