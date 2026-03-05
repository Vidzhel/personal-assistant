CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  action_name TEXT NOT NULL,
  permission_tier TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details TEXT,
  session_id TEXT,
  pipeline_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_skill_name ON audit_log(skill_name);
CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON audit_log(outcome);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  details TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  session_id TEXT,
  pipeline_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_resolution ON pending_approvals(resolution);
