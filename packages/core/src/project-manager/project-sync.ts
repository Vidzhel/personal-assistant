import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  gitAutoCommit,
  META_PROJECT_ID,
  type Project,
  type ProjectNode,
} from '@raven/shared';
import type Database from 'better-sqlite3';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import {
  parseProjectRow,
  getProjectRow,
  projectFromNode,
  projectMetadata,
  projectReferences,
  saveProjectRow,
  type ProjectRow,
} from './project-cache.ts';
import { withProjectMutation, ProjectMutationError } from './project-mutation.ts';
import { managedPath, pathPresent, assertProjectPath } from './project-files.ts';

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
    const project = parseProjectRow(getProjectRow(deps.db, META_PROJECT_ID));
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

function existingForNode(db: Database.Database, node: ProjectNode): ProjectRow | undefined {
  const linked = db.prepare('SELECT * FROM projects WHERE fs_path = ?').get(node.id) as
    ProjectRow | undefined;
  if (linked) return linked;
  const id = node.isMeta ? META_PROJECT_ID : node.metadata?.id;
  if (id) {
    const identified = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      ProjectRow | undefined;
    if (identified?.fs_path && identified.fs_path !== node.id) {
      throw new ProjectMutationError(`Duplicate project identity at ${node.id}`);
    }
    return identified;
  }
  const legacy = db
    .prepare('SELECT * FROM projects WHERE fs_path IS NULL AND is_meta = 0')
    .all() as ProjectRow[];
  const candidates = legacy.filter((row) => kebabCase(row.name) === node.id);
  return candidates.find((row) => row.name === node.displayName) ?? candidates[0];
}

function discoveredProject(node: ProjectNode): Project {
  const now = Date.now();
  return {
    id: node.metadata?.id ?? node.id,
    name: node.displayName ?? node.name,
    skills: [],
    systemAccess: 'none',
    isMeta: node.isMeta,
    createdAt: now,
    updatedAt: now,
  };
}

function assertOrdinaryIdentity(node: ProjectNode, existing?: ProjectRow): void {
  if (!node.isMeta && (node.metadata?.id === META_PROJECT_ID || existing?.is_meta)) {
    throw new ProjectMutationError(`System identity cannot belong to ${node.id}`);
  }
}

function cacheNode(db: Database.Database, node: ProjectNode): 'linked' | 'created' | undefined {
  const existing = existingForNode(db, node);
  assertOrdinaryIdentity(node, existing);
  const base = existing ? parseProjectRow(existing) : discoveredProject(node);
  if (!existing && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(base.id)) {
    throw new ProjectMutationError(`Project ID conflicts at ${node.id}`);
  }
  saveProjectRow(db, projectFromNode(node, base));
  if (!existing) return 'created';
  return existing.fs_path ? undefined : 'linked';
}

export function syncProjectCache(deps: Pick<ProjectSyncDeps, 'db' | 'projectRegistry'>): {
  linked: number;
  created: number;
} {
  deps.projectRegistry.assertHealthy();
  return deps.db.transaction(() => {
    const result = { linked: 0, created: 0 };
    for (const node of deps.projectRegistry.listProjects()) {
      const kind = cacheNode(deps.db, node);
      if (kind) result[kind]++;
    }
    return result;
  })();
}

function hasConfig(row: ProjectRow): boolean {
  return (
    row.description !== null ||
    row.system_prompt !== null ||
    row.skills !== '[]' ||
    row.system_access !== 'none'
  );
}

async function orphanPath(deps: ProjectSyncDeps, name: string): Promise<string> {
  let base = kebabCase(name);
  try {
    assertProjectPath(base);
  } catch {
    base = `project-${base}`;
  }
  let path = base;
  let suffix = 1;
  while (
    deps.projectRegistry.getProject(path) ||
    (await pathPresent(await managedPath(deps.projectsDir, path)))
  ) {
    path = `${base}-${++suffix}`;
  }
  return path;
}

async function scaffoldOrphan(deps: ProjectSyncDeps, row: ProjectRow): Promise<void> {
  const fsPath = await orphanPath(deps, row.name);
  const project = { ...parseProjectRow(row), fsPath };
  await deps.scaffoldingApi.createProject({ ...projectMetadata(project), path: fsPath });
  try {
    if (getProjectRow(deps.db, row.id).fs_path !== fsPath) saveProjectRow(deps.db, project);
  } catch (error) {
    await rm(await managedPath(deps.projectsDir, fsPath), { recursive: true });
    await deps.projectRegistry.load(deps.projectsDir);
    throw error;
  }
  await gitAutoCommit(
    [join(deps.projectsDir, fsPath, 'context.md')],
    `fix(project): reconcile ${fsPath}`,
  );
}

async function reconcileOrphans(deps: ProjectSyncDeps, result: ProjectSyncResult): Promise<void> {
  const orphans = deps.db
    .prepare('SELECT * FROM projects WHERE fs_path IS NULL AND is_meta = 0')
    .all() as ProjectRow[];
  for (const row of orphans) {
    if (hasConfig(row) || projectReferences(deps.db, row.id).length > 0) {
      await scaffoldOrphan(deps, row);
      result.scaffolded++;
    } else {
      deps.db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
      result.dropped++;
    }
  }
}

/** Invalid/incomplete registry loads must never be interpreted as empty owner state. */
export async function runProjectSync(deps: ProjectSyncDeps): Promise<ProjectSyncResult> {
  return withProjectMutation(deps.projectsDir, async () => {
    deps.projectRegistry.assertHealthy();
    await ensureMetaProjectNode(deps);
    const result: ProjectSyncResult = { linked: 0, created: 0, scaffolded: 0, dropped: 0 };
    Object.assign(result, syncProjectCache(deps));
    await reconcileOrphans(deps, result);
    log.info(`Project sync: ${JSON.stringify(result)}`);
    return result;
  });
}
