import type { FastifyInstance } from 'fastify';
import {
  createLogger,
  generateId,
  HTTP_STATUS,
  type Project,
  ProjectCreateInput,
  ProjectUpdateInput,
} from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { ProjectRegistry } from '../../project-registry/project-registry.ts';
import type { TemplateRegistry } from '../../template-engine/template-registry.ts';
import type { ScaffoldingApi } from '../../scaffolding/scaffolding-api.ts';
import { getDb } from '../../db/database.ts';
import { kebabCase } from '../../project-manager/project-sync.ts';

const log = createLogger('api:projects');

const BAD_REQUEST = 400;
const INTERNAL_SERVER_ERROR = 500;

interface ProjectRouteDeps {
  eventBus: EventBus;
  projectRegistry?: ProjectRegistry;
  templateRegistry?: TemplateRegistry;
  scaffoldingApi?: ScaffoldingApi;
  projectsDir?: string;
}

// eslint-disable-next-line max-lines-per-function -- route registration for all project CRUD endpoints
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  app.get('/api/projects', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return rows.map((row) =>
      enrichWithRegistry(parseProjectRow(row), deps.projectRegistry, deps.templateRegistry),
    );
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!row) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return enrichWithRegistry(parseProjectRow(row), deps.projectRegistry, deps.templateRegistry);
  });

  // GET /api/projects/:id/children — list sub-projects from the filesystem registry
  app.get<{ Params: { id: string } }>('/api/projects/:id/children', async (req, reply) => {
    if (!deps.projectRegistry) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project registry not available' });
    }

    const { id } = req.params;

    // fs_path is the authoritative link (project-manager/project-sync.ts);
    // name match and direct id lookup are fallbacks for unreconciled rows.
    const db = getDb();
    const dbRow = db.prepare('SELECT name, fs_path FROM projects WHERE id = ?').get(id) as
      { name: string; fs_path: string | null } | undefined;

    const registryNode = dbRow?.fs_path
      ? deps.projectRegistry.getProject(dbRow.fs_path)
      : dbRow
        ? deps.projectRegistry.findByName(dbRow.name)
        : deps.projectRegistry.getProject(id);

    if (!registryNode) {
      return [];
    }

    const children = deps.projectRegistry.getProjectChildren(registryNode.id);
    return children.map((child) => ({
      id: child.id,
      name: child.name,
      displayName: child.displayName,
      description: child.description,
      path: child.relativePath,
      hasContextMd: child.contextMd.length > 0,
      childCount: child.children.length,
    }));
  });

  app.post('/api/projects', async (req, reply) => {
    const parsed = ProjectCreateInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(BAD_REQUEST).send({ error: parsed.error.message });
    }

    const body = req.body as Record<string, unknown>;
    if (body.isMeta === true) {
      return reply.status(BAD_REQUEST).send({ error: 'Cannot create a meta-project via API' });
    }

    const outcome = await createProjectRow(deps, parsed.data);
    if (outcome.kind === 'conflict') {
      return reply
        .status(BAD_REQUEST)
        .send({ error: `Project path "${outcome.fsPath}" already exists` });
    }
    if (outcome.kind === 'scaffold-failed') {
      return reply
        .status(INTERNAL_SERVER_ERROR)
        .send({ error: 'Failed to scaffold project directory' });
    }

    deps.eventBus.emit({
      id: generateId(),
      timestamp: outcome.project.createdAt,
      source: 'api',
      type: 'project:created',
      payload: { projectId: outcome.project.id, projectName: outcome.project.name },
    });

    return outcome.project;
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const parsed = ProjectUpdateInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(BAD_REQUEST).send({ error: parsed.error.message });
    }

    const body = req.body as Record<string, unknown>;
    if (body.isMeta !== undefined) {
      return reply.status(BAD_REQUEST).send({ error: 'Cannot modify the is_meta field' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!existing) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });

    const updates = parsed.data;
    const now = Date.now();
    db.prepare(
      'UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), skills = COALESCE(?, skills), system_prompt = COALESCE(?, system_prompt), system_access = COALESCE(?, system_access), updated_at = ? WHERE id = ?',
    ).run(
      updates.name ?? null,
      updates.description ?? null,
      updates.skills ? JSON.stringify(updates.skills) : null,
      updates.systemPrompt ?? null,
      updates.systemAccess ?? null,
      now,
      req.params.id,
    );

    return { success: true };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const db = getDb();

    // Prevent deletion of meta-project
    const row = db.prepare('SELECT is_meta FROM projects WHERE id = ?').get(req.params.id) as
      { is_meta: number } | undefined;
    if (row?.is_meta === 1) {
      return reply.status(BAD_REQUEST).send({ error: 'Cannot delete the system meta-project' });
    }

    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0)
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });

    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'api',
      type: 'project:deleted',
      payload: { projectId: req.params.id },
    });

    return { success: true };
  });
}

/**
 * Scaffolds a directory for `fsPath` when the registry has no node there
 * yet, reloading the registry so the caller can immediately look it up.
 * Returns the linked registry node id, or undefined when scaffolding deps
 * aren't wired (degraded/isolated-test mode — caller falls back to a
 * DB-only row, same as before this invariant existed).
 */
async function scaffoldProjectDir(
  deps: ProjectRouteDeps,
  fsPath: string,
  input: { displayName: string; description?: string },
): Promise<string | undefined> {
  if (!deps.scaffoldingApi || !deps.projectRegistry || !deps.projectsDir) return undefined;

  if (!deps.projectRegistry.getProject(fsPath)) {
    await deps.scaffoldingApi.createProject({
      path: fsPath,
      displayName: input.displayName,
      description: input.description,
    });
    await deps.projectRegistry.load(deps.projectsDir);
  }

  return deps.projectRegistry.getProject(fsPath)?.id;
}

type CreateProjectOutcome =
  | { kind: 'conflict'; fsPath: string }
  | { kind: 'scaffold-failed' }
  | { kind: 'ok'; project: Project };

/**
 * Scaffolds (or reuses) the directory for the project's kebab-cased name,
 * then inserts the DB cache row keyed to it. A pre-existing row at that
 * fs_path is treated as a conflict rather than silently reused, since two
 * distinct names that kebab-case to the same path would otherwise clobber
 * each other's directory.
 */
async function createProjectRow(
  deps: ProjectRouteDeps,
  data: ProjectCreateInput,
): Promise<CreateProjectOutcome> {
  const { name, description, skills, systemPrompt, systemAccess } = data;
  const db = getDb();
  const fsPath = kebabCase(name);

  if (db.prepare('SELECT 1 FROM projects WHERE fs_path = ?').get(fsPath)) {
    return { kind: 'conflict', fsPath };
  }

  let linkedFsPath: string | undefined;
  try {
    linkedFsPath = await scaffoldProjectDir(deps, fsPath, { displayName: name, description });
  } catch (err) {
    log.error(`Failed to scaffold project directory "${fsPath}": ${err}`);
    return { kind: 'scaffold-failed' };
  }

  const id = linkedFsPath ?? generateId();
  const now = Date.now();

  db.prepare(
    'INSERT INTO projects (id, name, description, skills, system_prompt, system_access, fs_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    name,
    description ?? null,
    JSON.stringify(skills ?? []),
    systemPrompt ?? null,
    systemAccess,
    linkedFsPath ?? null,
    now,
    now,
  );

  return {
    kind: 'ok',
    project: {
      id,
      name,
      description,
      skills: skills ?? [],
      systemPrompt,
      systemAccess,
      isMeta: false,
      fsPath: linkedFsPath,
      createdAt: now,
      updatedAt: now,
    },
  };
}

interface EnrichedProject extends Project {
  parentId?: string;
  children?: string[];
  hasContextMd?: boolean;
  agentCount?: number;
  templateCount?: number;
}

function enrichWithRegistry(
  project: Project,
  registry?: ProjectRegistry,
  templateRegistry?: TemplateRegistry,
): EnrichedProject {
  if (!registry) return project;

  // fs_path is the authoritative link; name match is a fallback for rows
  // not yet reconciled by project-manager/project-sync.ts.
  const node = project.fsPath
    ? registry.getProject(project.fsPath)
    : registry.findByName(project.name);
  if (!node) return project;

  return {
    ...project,
    parentId: node.parentId ?? undefined,
    children: node.children,
    hasContextMd: node.contextMd.length > 0,
    agentCount: node.agents.length,
    templateCount: templateRegistry ? templateRegistry.listTemplates(node.id).length : 0,
  };
}

function parseProjectRow(row: unknown): Project {
  const r = row as {
    id: string;
    name: string;
    description: string | null;
    skills: string;
    system_prompt: string | null;
    system_access: string;
    is_meta: number;
    fs_path: string | null;
    created_at: number;
    updated_at: number;
  };
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    skills: JSON.parse(r.skills),
    systemPrompt: r.system_prompt ?? undefined,
    systemAccess: (r.system_access ?? 'none') as Project['systemAccess'],
    isMeta: r.is_meta === 1,
    fsPath: r.fs_path ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
