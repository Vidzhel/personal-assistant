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
import type { ScaffoldingApi } from '../../scaffolding/scaffolding-api.ts';
import { getDb } from '../../db/database.ts';
import {
  createManagedProject,
  updateManagedProject,
  deleteManagedProject,
  type ProjectLifecycleDeps,
} from '../../project-manager/project-lifecycle.ts';
import { parseProjectRow, type ProjectRow } from '../../project-manager/project-cache.ts';
import { ProjectMutationError } from '../../project-manager/project-mutation.ts';
import type { Neo4jClient } from '../../knowledge-engine/neo4j-client.ts';
import {
  isActiveProject,
  isCurrentProject,
  isCurrentProjectLink,
} from '../../project-manager/project-active.ts';

const BAD_REQUEST = 400;

interface ProjectRouteDeps {
  eventBus: EventBus;
  projectRegistry?: ProjectRegistry;
  templateRegistry?: TemplateRegistry;
  scaffoldingApi?: ScaffoldingApi;
  projectsDir?: string;
  neo4jClient?: Neo4jClient;
}

// eslint-disable-next-line max-lines-per-function -- route registration for all project CRUD endpoints
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  app.get('/api/projects', async () => {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT * FROM projects WHERE fs_path IS NOT NULL AND fs_path <> ? ORDER BY updated_at DESC',
      )
      .all('');
    return rows
      .map((row) => parseProjectRow(row as ProjectRow))
      .filter((project) => isCurrentProjectLink(project.id, project.fsPath, deps.projectRegistry))
      .map((project) => enrichWithRegistry(project, deps.projectRegistry, deps.templateRegistry));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM projects WHERE id = ? AND fs_path IS NOT NULL AND fs_path <> ?')
      .get(req.params.id, '') as ProjectRow | undefined;
    if (!row) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    const project = parseProjectRow(row);
    if (!isCurrentProject(getDb(), project.id, deps.projectRegistry)) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    }
    return enrichWithRegistry(project, deps.projectRegistry, deps.templateRegistry);
  });

  // GET /api/projects/:id/children — list sub-projects from the filesystem registry
  app.get<{ Params: { id: string } }>('/api/projects/:id/children', async (req, reply) => {
    if (!deps.projectRegistry) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project registry not available' });
    }

    const { id } = req.params;

    // fs_path is the authoritative link (project-manager/project-sync.ts).
    const db = getDb();
    const dbRow = db
      .prepare('SELECT fs_path FROM projects WHERE id = ? AND fs_path IS NOT NULL AND fs_path <> ?')
      .get(id, '') as { fs_path: string } | undefined;

    const registryNode = dbRow ? deps.projectRegistry.getProject(dbRow.fs_path) : undefined;

    if (!registryNode) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project not found' });
    }

    const children = deps.projectRegistry.getProjectChildren(registryNode.id);
    return children.map((child) => ({
      id: cacheProjectId(child.id),
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

    const project = await createManagedProject(lifecycleDeps(deps), parsed.data);

    deps.eventBus.emit({
      id: generateId(),
      timestamp: project.createdAt,
      source: 'api',
      type: 'project:created',
      payload: { projectId: project.id, projectName: project.name },
    });

    return project;
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!isActiveProject(getDb(), req.params.id)) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    }
    const parsed = ProjectUpdateInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(BAD_REQUEST).send({ error: parsed.error.message });
    }

    const body = req.body as Record<string, unknown>;
    if (body.isMeta !== undefined) {
      return reply.status(BAD_REQUEST).send({ error: 'Cannot modify the is_meta field' });
    }

    await updateManagedProject(lifecycleDeps(deps), req.params.id, parsed.data);

    return { success: true };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!isActiveProject(getDb(), req.params.id)) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    }
    const result = await deleteManagedProject(lifecycleDeps(deps), req.params.id);

    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'api',
      type: 'project:deleted',
      payload: { projectId: req.params.id },
    });

    return { success: true, ...result };
  });
}

function lifecycleDeps(deps: ProjectRouteDeps): ProjectLifecycleDeps {
  if (!deps.projectsDir || !deps.projectRegistry || !deps.scaffoldingApi) {
    throw new ProjectMutationError(
      'Project definition storage is unavailable',
      HTTP_STATUS.SERVICE_UNAVAILABLE,
    );
  }
  return {
    ...deps,
    db: getDb(),
    projectsDir: deps.projectsDir,
    projectRegistry: deps.projectRegistry,
    scaffoldingApi: deps.scaffoldingApi,
  };
}

function cacheProjectId(fsPath: string): string | undefined {
  return (
    getDb()
      .prepare('SELECT id FROM projects WHERE fs_path = ? AND fs_path <> ?')
      .get(fsPath, '') as { id: string } | undefined
  )?.id;
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

  // fs_path is the authoritative link. A project without one is historical
  // cache state and is filtered before enrichment.
  const node = project.fsPath ? registry.getProject(project.fsPath) : undefined;
  if (!node) return project;

  return {
    ...project,
    parentId: node.parentId ? cacheProjectId(node.parentId) : undefined,
    children: node.children.map(cacheProjectId).filter((id): id is string => id !== undefined),
    hasContextMd: node.contextMd.length > 0,
    agentCount: node.agents.length,
    templateCount: templateRegistry ? templateRegistry.listTemplates(node.id).length : 0,
  };
}
