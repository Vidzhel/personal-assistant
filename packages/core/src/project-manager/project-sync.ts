import { join } from 'node:path';
import { createLogger, gitAutoCommit, META_PROJECT_ID, type ProjectNode } from '@raven/shared';
import type Database from 'better-sqlite3';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import {
  parseProjectRow,
  projectFromNode,
  projectMetadata,
  projectReferences,
  saveProjectRow,
  type ProjectRow,
} from './project-cache.ts';
import { withProjectMutation, ProjectMutationError } from './project-mutation.ts';

const log = createLogger('project-sync');

export interface ProjectSyncDeps {
  db: Database.Database;
  projectRegistry: ProjectRegistry;
  scaffoldingApi: ScaffoldingApi;
  projectsDir: string;
}

export interface ProjectSyncResult {
  linked: number;
  created: number;
  scaffolded: number;
  dropped: number;
}

export function kebabCase(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

async function ensureMetaProjectNode(deps: ProjectSyncDeps): Promise<void> {
  if (!deps.projectRegistry.getProject('system')) {
    // The reserved system project is the one built-in definition whose
    // invariants do not come from a project file or a stale cache row.
    const project = {
      id: META_PROJECT_ID,
      name: 'Raven System',
      skills: [],
      systemAccess: 'read-write' as const,
      isMeta: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await deps.scaffoldingApi.createProject(
      { ...projectMetadata(project), path: 'system' },
      { system: true },
    );
    await gitAutoCommit(
      [join(deps.projectsDir, 'system', 'context.md')],
      'feat(project): scaffold system',
    );
  }
}

function assertOrdinaryIdentity(node: ProjectNode, existing?: ProjectRow): void {
  if (!node.isMeta && (node.metadata?.id === META_PROJECT_ID || existing?.is_meta)) {
    throw new ProjectMutationError(`System identity cannot belong to ${node.id}`);
  }
}

function canonicalProjectId(node: ProjectNode): string {
  return node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id);
}

function rowByPath(db: Database.Database, path: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE fs_path = ?').get(path) as ProjectRow | undefined;
}

function rowByCanonicalId(db: Database.Database, node: ProjectNode): ProjectRow | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(canonicalProjectId(node)) as
    ProjectRow | undefined;
  if (row?.fs_path && row.fs_path !== node.id) {
    throw new ProjectMutationError(`Duplicate project identity at ${node.id}`);
  }
  return row;
}

/**
 * A path that used to belong to another plain-file identity is stale state.
 * Detach it while retaining referenced rows so operational history remains
 * addressable; never reuse its settings or identity for the current file.
 */
function detachForeignPathRow(db: Database.Database, row: ProjectRow): void {
  if (projectReferences(db, row.id).length > 0) {
    db.prepare('UPDATE projects SET fs_path = NULL WHERE id = ?').run(row.id);
  } else {
    db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
  }
}

function existingForNode(db: Database.Database, node: ProjectNode): ProjectRow | undefined {
  const identified = rowByCanonicalId(db, node);
  const linked = rowByPath(db, node.id);
  const canonicalId = canonicalProjectId(node);

  if (linked && linked.id !== canonicalId) {
    if (node.metadata || node.isMeta) {
      throw new ProjectMutationError(`Project identity conflicts at ${node.id}`);
    }
    detachForeignPathRow(db, linked);
  }

  return identified;
}

function cacheNode(db: Database.Database, node: ProjectNode): 'linked' | 'created' | undefined {
  const existing = existingForNode(db, node);
  assertOrdinaryIdentity(node, existing);
  if (existing?.fs_path === null && !node.isMeta && projectReferences(db, existing.id).length > 0) {
    throw new ProjectMutationError(
      `Project identity ${existing.id} is retained for referenced stale data and cannot be rebound`,
    );
  }
  saveProjectRow(db, projectFromNode(node, existing ? parseProjectRow(existing) : undefined));
  if (!existing) return 'created';
  return existing.fs_path ? undefined : 'linked';
}

export function syncProjectCache(deps: Pick<ProjectSyncDeps, 'db' | 'projectRegistry'>): {
  linked: number;
  created: number;
  dropped: number;
} {
  deps.projectRegistry.assertHealthy();
  return deps.db.transaction(() => {
    const nodes = deps.projectRegistry.listProjects();
    const result = { linked: 0, created: 0, dropped: 0 };
    for (const node of nodes) {
      const kind = cacheNode(deps.db, node);
      if (kind) result[kind]++;
    }
    const currentIds = new Set(nodes.map(canonicalProjectId));
    for (const row of deps.db
      .prepare('SELECT * FROM projects WHERE is_meta = 0')
      .all() as ProjectRow[]) {
      if (currentIds.has(row.id)) continue;
      const references = projectReferences(deps.db, row.id);
      if (references.length > 0) {
        if (row.fs_path !== null) {
          deps.db.prepare('UPDATE projects SET fs_path = NULL WHERE id = ?').run(row.id);
        }
        continue;
      }
      deps.db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
      result.dropped++;
    }
    return result;
  })();
}

/** Invalid/incomplete registry loads must never be interpreted as empty owner state. */
export async function runProjectSync(deps: ProjectSyncDeps): Promise<ProjectSyncResult> {
  return withProjectMutation(deps.projectsDir, async () => {
    deps.projectRegistry.assertHealthy();
    await ensureMetaProjectNode(deps);
    const result: ProjectSyncResult = { linked: 0, created: 0, scaffolded: 0, dropped: 0 };
    Object.assign(result, syncProjectCache(deps));
    log.info(`Project sync: ${JSON.stringify(result)}`);
    return result;
  });
}
