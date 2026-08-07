import { createLogger, META_PROJECT_ID } from '@raven/shared';
import type Database from 'better-sqlite3';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldingApi } from '../scaffolding/scaffolding-api.ts';

const log = createLogger('project-sync');

const META_DISPLAY_NAME = 'Raven System';
const META_DESCRIPTION = 'System management and administration';
const META_FS_PATH = 'system';

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

interface ProjectCacheRow {
  id: string;
  name: string;
  fs_path: string | null;
  is_meta: number;
}

/**
 * Lowercases, strips anything that isn't [a-z0-9], and collapses separator
 * runs into single hyphens. Falls back to "untitled" for inputs that reduce
 * to nothing (pure punctuation/emoji topic names, etc).
 */
export function kebabCase(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/** Appends -2, -3, ... until the path has no existing registry node. */
export function uniqueFsPath(projectRegistry: ProjectRegistry, base: string): string {
  if (!projectRegistry.getProject(base)) return base;
  let suffix = 2;
  while (projectRegistry.getProject(`${base}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${base}-${String(suffix)}`;
}

function findRowByFsPath(db: Database.Database, fsPath: string): ProjectCacheRow | undefined {
  return db
    .prepare('SELECT id, name, fs_path, is_meta FROM projects WHERE fs_path = ?')
    .get(fsPath) as ProjectCacheRow | undefined;
}

/** Legacy (pre-fs_path) rows keyed by the kebab-case of their display name
 * — the same slug scaffolding derives from a display name — so a row named
 * "Legacy Project" matches a `legacy-project/` directory even though the
 * stored strings differ in case and separators. Two differently-named rows
 * can kebab to the same slug (e.g. "Legacy Project" and "legacy  project"
 * both -> "legacy-project"), so each slug maps to every candidate row, not
 * just one — a plain `new Map(rows.map(...))` would silently keep only the
 * last row inserted under a colliding key and drop the rest from the sync
 * pass entirely (they'd never even reach the orphan-reconcile step). */
function unlinkedRowsByKebabName(db: Database.Database): Map<string, ProjectCacheRow[]> {
  const rows = db
    .prepare(
      'SELECT id, name, fs_path, is_meta FROM projects WHERE fs_path IS NULL AND is_meta = 0',
    )
    .all() as ProjectCacheRow[];
  const map = new Map<string, ProjectCacheRow[]>();
  for (const row of rows) {
    const slug = kebabCase(row.name);
    const existing = map.get(slug);
    if (existing) existing.push(row);
    else map.set(slug, [row]);
  }
  return map;
}

/** Among rows that collided on the same kebab slug, prefer the one whose
 * name matches the registry node's display name exactly; otherwise take
 * the first and log the rest as discarded (still visible to
 * reconcileOrphanRows afterward — this only picks which one gets linked to
 * THIS node, it doesn't drop anything from the DB). */
function pickBestCandidate(candidates: ProjectCacheRow[], displayName: string): ProjectCacheRow {
  const chosen = candidates.find((r) => r.name === displayName) ?? candidates[0];
  for (const row of candidates) {
    if (row.id === chosen.id) continue;
    log.warn(
      `Kebab-slug collision: legacy project row "${row.id}" (${row.name}) discarded in favor of "${chosen.id}" (${chosen.name})`,
    );
  }
  return chosen;
}

/**
 * Used by ensureProject (orchestrator) for ids with a fixed literal meaning
 * — Telegram topic ids, the "meta" system project — rather than the
 * fs_path-as-id convention syncFromRegistry uses for freshly-discovered
 * directories that never had a caller-assigned id.
 */
export function upsertCacheRow(
  db: Database.Database,
  input: { id: string; name: string; fsPath: string | null; description?: string },
): void {
  const { id, name, fsPath, description } = input;
  const now = Date.now();
  const existing = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  if (existing) {
    db.prepare(
      'UPDATE projects SET fs_path = COALESCE(?, fs_path), updated_at = ? WHERE id = ?',
    ).run(fsPath, now, id);
    return;
  }
  db.prepare(
    'INSERT INTO projects (id, name, description, skills, fs_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, name, description ?? null, '[]', fsPath, now, now);
}

/**
 * The meta-project's DB row (id='meta') is seeded by migration 017 and must
 * never be renamed or dropped, but it still needs a registry node to
 * resolve context/agents through. Scaffolds `projects/system` when it's
 * missing (e.g. a fresh minimal projects dir in tests) so the linkage
 * always succeeds.
 */
async function ensureMetaProjectNode(deps: ProjectSyncDeps): Promise<void> {
  const { db, projectRegistry, scaffoldingApi, projectsDir } = deps;
  let metaNode = projectRegistry.listProjects().find((p) => p.isMeta);

  if (!metaNode) {
    try {
      await scaffoldingApi.createProject({
        path: META_FS_PATH,
        displayName: META_DISPLAY_NAME,
        description: META_DESCRIPTION,
        systemAccess: 'read-write',
      });
      await projectRegistry.load(projectsDir);
      metaNode = projectRegistry.listProjects().find((p) => p.isMeta);
    } catch (err) {
      log.error(`Failed to scaffold meta-project directory: ${err}`);
      return;
    }
  }

  if (!metaNode) {
    log.warn('Meta-project registry node still missing after scaffold attempt');
    return;
  }

  db.prepare('UPDATE projects SET fs_path = ?, updated_at = ? WHERE id = ?').run(
    metaNode.id,
    Date.now(),
    META_PROJECT_ID,
  );
  log.info(`Meta-project linked to registry node "${metaNode.id}"`);
}

/**
 * Boot + post-scaffold: ensure every registry node (directory under
 * projects/) has a matching DB cache row. Links legacy rows by
 * case-insensitive name match (the pre-fs_path lookup convention
 * routes/projects.ts and orchestrator.ts used), or creates a fresh row
 * (id === fs_path) for directories nobody has a row for yet. Idempotent.
 */
function syncFromRegistry(deps: ProjectSyncDeps): { linked: number; created: number } {
  const { db, projectRegistry } = deps;
  let linked = 0;
  let created = 0;
  const now = Date.now();
  const unlinkedByKebabName = unlinkedRowsByKebabName(db);

  for (const node of projectRegistry.listProjects()) {
    if (node.isMeta) continue; // handled by ensureMetaProjectNode

    const displayName = node.displayName ?? node.name;

    if (findRowByFsPath(db, node.id)) {
      db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE fs_path = ?').run(
        displayName,
        now,
        node.id,
      );
      continue;
    }

    const legacyCandidates = unlinkedByKebabName.get(node.id);
    if (legacyCandidates && legacyCandidates.length > 0) {
      const legacy = pickBestCandidate(legacyCandidates, displayName);
      db.prepare('UPDATE projects SET fs_path = ?, updated_at = ? WHERE id = ?').run(
        node.id,
        now,
        legacy.id,
      );
      log.info(`Linked legacy project row "${legacy.id}" to registry node "${node.id}"`);
      linked += 1;
      continue;
    }

    db.prepare(
      'INSERT INTO projects (id, name, description, skills, fs_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(node.id, displayName, null, '[]', node.id, now, now);
    log.info(`Created cache row for registry node "${node.id}"`);
    created += 1;
  }

  return { linked, created };
}

/** True if any other table still holds data that names this project id —
 * sessions and project_data_sources are hard FKs (deleting while referenced
 * throws), agent_tasks/tasks/task_trees/events/knowledge_rejections are
 * soft references worth preserving context for. events and
 * knowledge_rejections both carry project_id but have no FK constraint, so
 * a row could be silently DELETEd out from under still-live event history
 * or rejection tracking without these two checks. */
function isReferenced(db: Database.Database, projectId: string): boolean {
  const checks = [
    'SELECT 1 FROM sessions WHERE project_id = ?',
    'SELECT 1 FROM agent_tasks WHERE project_id = ?',
    'SELECT 1 FROM tasks WHERE project_id = ?',
    'SELECT 1 FROM task_trees WHERE project_id = ?',
    'SELECT 1 FROM project_data_sources WHERE project_id = ?',
    'SELECT 1 FROM events WHERE project_id = ?',
    'SELECT 1 FROM knowledge_rejections WHERE project_id = ?',
  ];
  return checks.some((sql) => db.prepare(sql).get(projectId) !== undefined);
}

interface OrphanRow extends ProjectCacheRow {
  system_prompt: string | null;
  description: string | null;
  skills: string;
}

/** True if the row itself carries configuration that exists nowhere but
 * this DB row — deleting it (rather than scaffolding a home for it) would
 * be actual data loss, not just cache cleanup. */
function carriesConfig(row: OrphanRow): boolean {
  return row.system_prompt !== null || row.description !== null || row.skills !== '[]';
}

async function scaffoldOrphan(
  deps: ProjectSyncDeps,
  row: ProjectCacheRow,
  reason: string,
): Promise<boolean> {
  const { db, projectRegistry, scaffoldingApi, projectsDir } = deps;
  const fsPath = uniqueFsPath(projectRegistry, kebabCase(row.name));
  try {
    await scaffoldingApi.createProject({
      path: fsPath,
      displayName: row.name,
      description: 'Reconciled from a legacy database-only project row',
    });
    await projectRegistry.load(projectsDir);
    db.prepare('UPDATE projects SET fs_path = ?, updated_at = ? WHERE id = ?').run(
      fsPath,
      Date.now(),
      row.id,
    );
    log.info(`Scaffolded "${fsPath}" for legacy project "${row.id}" (${row.name}) — ${reason}`);
    return true;
  } catch (err) {
    log.error(`Failed to scaffold directory for legacy project "${row.id}": ${err}`);
    return false;
  }
}

/**
 * Whatever's left unlinked after syncFromRegistry has no matching directory
 * at all. Two kinds of rows get a real directory scaffolded so they rejoin
 * the one-store invariant rather than being dropped: rows still referenced
 * by other tables (sessions/tasks/events/...), and rows that carry their
 * own configuration (system_prompt/description/skills) which lives nowhere
 * but this row — dropping either would be data loss, not cache cleanup.
 * Only a row with neither is actually disposable. Every decision is logged.
 */
async function reconcileOrphanRows(
  deps: ProjectSyncDeps,
): Promise<{ scaffolded: number; dropped: number }> {
  const { db } = deps;
  const orphans = db
    .prepare(
      'SELECT id, name, fs_path, is_meta, system_prompt, description, skills FROM projects WHERE fs_path IS NULL AND is_meta = 0',
    )
    .all() as OrphanRow[];

  let scaffolded = 0;
  let dropped = 0;

  for (const row of orphans) {
    const referenced = isReferenced(db, row.id);
    const hasConfig = carriesConfig(row);

    if (referenced || hasConfig) {
      const reason = referenced
        ? 'still referenced by other data'
        : 'carries config (system_prompt/description/skills) with no other home';
      if (await scaffoldOrphan(deps, row, reason)) scaffolded += 1;
      continue;
    }

    db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
    log.info(
      `Dropped orphaned project row "${row.id}" (${row.name}) — no registry node, no references, no config`,
    );
    dropped += 1;
  }

  return { scaffolded, dropped };
}

/**
 * Entry point: call on boot (after the registry loads) and after any
 * scaffold operation. Idempotent in every phase.
 */
export async function runProjectSync(deps: ProjectSyncDeps): Promise<ProjectSyncResult> {
  await ensureMetaProjectNode(deps);
  const { linked, created } = syncFromRegistry(deps);
  const { scaffolded, dropped } = await reconcileOrphanRows(deps);
  log.info(
    `Project sync: ${String(linked)} linked, ${String(created)} created, ${String(scaffolded)} scaffolded, ${String(dropped)} dropped`,
  );
  return { linked, created, scaffolded, dropped };
}
