CREATE TABLE engagement_metrics (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  notification_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_engagement_created ON engagement_metrics(created_at);
CREATE INDEX idx_engagement_type ON engagement_metrics(event_type);
CREATE INDEX idx_engagement_notification ON engagement_metrics(notification_id);
