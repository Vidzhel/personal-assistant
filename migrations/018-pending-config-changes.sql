CREATE TABLE IF NOT EXISTS pending_config_changes (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,  -- 'pipeline' | 'suite' | 'agent' | 'schedule'
  resource_name TEXT NOT NULL,
  action TEXT NOT NULL,          -- 'create' | 'update' | 'delete' | 'view'
  current_content TEXT,
  proposed_content TEXT,
  diff_text TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'applied' | 'discarded'
  telegram_message_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
