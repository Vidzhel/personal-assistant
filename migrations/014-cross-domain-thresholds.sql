CREATE TABLE IF NOT EXISTS cross_domain_thresholds (
  domain_pair TEXT PRIMARY KEY,
  threshold REAL NOT NULL DEFAULT 0.75,
  dismissal_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cross_domain_dismissals (
  id TEXT PRIMARY KEY,
  insight_id TEXT NOT NULL,
  domain_pair TEXT NOT NULL,
  created_at TEXT NOT NULL
);
