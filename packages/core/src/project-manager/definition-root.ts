import { lstatSync, mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ProjectMutationError } from './project-mutation.ts';

interface LinkedProjectRow {
  id: string;
  fs_path: string;
}

/** Create a fresh project root, but never recreate a root that may contain
 * owner definitions when the operational cache still points at paths. */
export function ensureProjectRoot(projectsDir: string, db: Database.Database): void {
  try {
    const status = lstatSync(projectsDir);
    if (!status.isDirectory()) {
      throw new ProjectMutationError(`Project root is not a directory: ${projectsDir}`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const linked = db
    .prepare('SELECT id, fs_path FROM projects WHERE fs_path IS NOT NULL LIMIT 1')
    .get() as LinkedProjectRow | undefined;
  if (linked) {
    throw new ProjectMutationError(
      `Project root is missing while cache row ${linked.id} points to ${linked.fs_path}`,
    );
  }
  mkdirSync(projectsDir, { recursive: true });
}
