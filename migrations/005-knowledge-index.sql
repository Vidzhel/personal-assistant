-- SQLite index for knowledge bubble metadata (source of truth is markdown files on disk)
CREATE TABLE knowledge_index (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  content_preview TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE knowledge_tags (
  bubble_id TEXT NOT NULL REFERENCES knowledge_index(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (bubble_id, tag)
);

CREATE INDEX idx_knowledge_index_created_at ON knowledge_index(created_at);
CREATE INDEX idx_knowledge_index_updated_at ON knowledge_index(updated_at);
CREATE INDEX idx_knowledge_tags_tag ON knowledge_tags(tag);

-- FTS5 for full-text search (bubble_id stored for joining back to index)
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  bubble_id,
  title,
  content
);
