-- 031-projects-fs-path.sql
-- Filesystem becomes the source of truth for project existence: a project
-- EXISTS iff a registry node (directory under projects/) exists for it. This
-- column links a `projects` cache row to its registry node by relative path
-- (ProjectNode.id === relativePath, e.g. "system", "chat-round-trip-project").
-- Rows without a matching directory are reconciled at boot by
-- project-manager/project-sync.ts (scaffolded if referenced by other data,
-- dropped otherwise).
ALTER TABLE projects ADD COLUMN fs_path TEXT;

-- Partial unique index: only rows that HAVE been linked to a registry node
-- are constrained to uniqueness — legacy unreconciled rows (fs_path IS NULL)
-- don't collide with each other while the boot-time reconciler catches up.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_fs_path ON projects(fs_path) WHERE fs_path IS NOT NULL;
