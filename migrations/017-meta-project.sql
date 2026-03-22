ALTER TABLE projects ADD COLUMN system_access TEXT NOT NULL DEFAULT 'none';
ALTER TABLE projects ADD COLUMN is_meta INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_projects_is_meta ON projects(is_meta);

-- Seed the meta-project for system management
INSERT OR IGNORE INTO projects (id, name, description, skills, system_prompt, system_access, is_meta, created_at, updated_at)
VALUES (
  'meta',
  'Raven System',
  'System management and administration',
  '[]',
  '',
  'read-write',
  1,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);
