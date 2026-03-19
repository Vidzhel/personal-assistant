-- Migration 011: Notification preferences (snooze)
-- Story 7.4: Category Snooze & Notification Preferences

CREATE TABLE IF NOT EXISTS notification_snooze (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  snoozed_until TEXT,
  held_count INTEGER NOT NULL DEFAULT 0,
  last_suggested_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snooze_category ON notification_snooze(category);
