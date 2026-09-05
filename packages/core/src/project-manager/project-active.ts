import type Database from 'better-sqlite3';
import { HTTP_STATUS, META_PROJECT_ID } from '@raven/shared';
import { ProjectMutationError } from './project-mutation.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';

/**
 * A project cache row is usable for new work only while it is linked to a
 * current definition path. Rows with no path are retained as historical
 * tombstones by project sync and must remain readable only through the
 * historical APIs that explicitly support that.
 */
export function isActiveProject(db: Database.Database, projectId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 FROM projects WHERE id = ? AND fs_path IS NOT NULL AND fs_path <> ?')
      .get(projectId, ''),
  );
}

export function assertActiveProject(db: Database.Database, projectId: string): void {
  if (!isActiveProject(db, projectId)) {
    throw new ProjectMutationError('Project not found', HTTP_STATUS.NOT_FOUND);
  }
}

/** Check the linked definition's identity when a loaded registry is available. */
export function isCurrentProject(
  db: Database.Database,
  projectId: string,
  registry?: ProjectRegistry,
): boolean {
  const active = isActiveProject(db, projectId);
  if (!active || !registry) return active;
  const row = db.prepare('SELECT fs_path FROM projects WHERE id = ?').get(projectId) as
    { fs_path: string | null } | undefined;
  if (!row?.fs_path) return false;
  return isCurrentProjectLink(projectId, row.fs_path, registry);
}

/** Registry check for a row whose active path has already been read. */
export function isCurrentProjectLink(
  projectId: string,
  fsPath: string | null | undefined,
  registry?: ProjectRegistry,
): boolean {
  if (!fsPath || !registry) return fsPath !== undefined && fsPath !== null && fsPath !== '';
  try {
    registry.assertHealthy();
  } catch {
    return false;
  }
  const node = registry.getProject(fsPath);
  if (!node) return false;
  const canonicalId = node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id);
  return canonicalId === projectId;
}
