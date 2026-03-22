CREATE TABLE IF NOT EXISTS named_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  instructions TEXT,
  suite_ids TEXT NOT NULL DEFAULT '[]',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_named_agents_name ON named_agents(name);

-- Seed the default "raven" agent (catch-all with all suites)
INSERT OR IGNORE INTO named_agents (id, name, description, instructions, suite_ids, is_default, created_at, updated_at)
VALUES (
  'default-raven-agent',
  'raven',
  'General-purpose assistant — handles all requests when no specialized agent is assigned',
  '',
  '[]',
  1,
  datetime('now'),
  datetime('now')
);
