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
