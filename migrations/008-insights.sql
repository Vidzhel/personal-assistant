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
