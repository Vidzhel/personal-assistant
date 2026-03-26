-- Project data sources: external URIs linked to projects (Google Drive, files, URLs)
CREATE TABLE IF NOT EXISTS project_data_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  uri TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('gdrive', 'file', 'url', 'other')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_data_sources_project ON project_data_sources(project_id);

-- Knowledge rejection tracking: prevents re-suggesting rejected content
CREATE TABLE IF NOT EXISTS knowledge_rejections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_rejections_lookup ON knowledge_rejections(project_id, content_hash);
