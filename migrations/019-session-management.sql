-- Session management: name, description, pin, summary columns + cross-references table
ALTER TABLE sessions ADD COLUMN name TEXT;
ALTER TABLE sessions ADD COLUMN description TEXT;
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN summary TEXT;

CREATE TABLE IF NOT EXISTS session_references (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL REFERENCES sessions(id),
  target_session_id TEXT NOT NULL REFERENCES sessions(id),
  context TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_references_source ON session_references(source_session_id);
CREATE INDEX IF NOT EXISTS idx_session_references_target ON session_references(target_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned);
