-- Self-test: durable per-fire schedule log + persisted self-test run results.
-- Written by scheduler/schedule-fire-log.ts and services/system/self-test.ts.

CREATE TABLE IF NOT EXISTS schedule_fires (
  id TEXT PRIMARY KEY,
  schedule_name TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  activation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'blocked', 'fired', 'failed')),
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_fires_schedule_name ON schedule_fires(schedule_name);
CREATE INDEX IF NOT EXISTS idx_schedule_fires_fired_at ON schedule_fires(fired_at);
CREATE INDEX IF NOT EXISTS idx_schedule_fires_activation ON schedule_fires(schedule_name, activation_id, fired_at);

CREATE TABLE IF NOT EXISTS self_test_results (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  violations_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_self_test_results_ran_at ON self_test_results(ran_at);
