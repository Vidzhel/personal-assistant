import type { FastifyInstance } from 'fastify';
import {
  generateId,
  HTTP_STATUS,
  type Project,
  ProjectCreateInput,
  ProjectUpdateInput,
} from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { ProjectRegistry } from '../../project-registry/project-registry.ts';
import type { TemplateRegistry } from '../../template-engine/template-registry.ts';
import { getDb } from '../../db/database.ts';

const BAD_REQUEST = 400;

interface ProjectRouteDeps {
  eventBus: EventBus;
  projectRegistry?: ProjectRegistry;
  templateRegistry?: TemplateRegistry;
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

    // Try to find by name match (DB project name → registry project name)
    const db = getDb();
    const dbRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as
      | { name: string }
      | undefined;

    const registryNode = dbRow
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

    const { name, description, skills, systemPrompt, systemAccess } = parsed.data;
    const db = getDb();
    const now = Date.now();
    const id = generateId();

    db.prepare(
      'INSERT INTO projects (id, name, description, skills, system_prompt, system_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      name,
      description ?? null,
      JSON.stringify(skills ?? []),
      systemPrompt ?? null,
      systemAccess,
      now,
      now,
    );

    const created = {
      id,
      name,
      description,
      skills: skills ?? [],
      systemPrompt,
      systemAccess,
      isMeta: false,
      createdAt: now,
      updatedAt: now,
    };

    deps.eventBus.emit({
      id: generateId(),
      timestamp: now,
      source: 'api',
      type: 'project:created',
      payload: { projectId: id, projectName: name },
    });

    return created;
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
      | { is_meta: number }
      | undefined;
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

  // Match DB project to registry by name (case-insensitive)
  const node = registry.findByName(project.name);
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
