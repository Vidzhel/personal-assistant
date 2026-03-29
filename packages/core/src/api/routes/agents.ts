import { resolve } from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  createLogger,
  NamedAgentCreateInputSchema,
  NamedAgentUpdateInputSchema,
  BashAccessSchema,
} from '@raven/shared';
import type { AgentYaml } from '@raven/shared';
import type { NamedAgentStore } from '../../agent-registry/named-agent-store.ts';
import type { AgentManager } from '../../agent-manager/agent-manager.ts';
import type { SuiteRegistry } from '../../suite-registry/suite-registry.ts';
import type { TaskStore } from '../../task-manager/task-store.ts';
import type { AgentYamlStore } from '../../project-registry/agent-yaml-store.ts';
import type { ProjectRegistry } from '../../project-registry/project-registry.ts';

const log = createLogger('api:agents');

const HTTP_STATUS = { OK_CREATED: 201, BAD_REQUEST: 400, NOT_FOUND: 404 } as const;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const TaskHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface AgentRouteDeps {
  namedAgentStore: NamedAgentStore;
  agentManager: AgentManager;
  suiteRegistry: SuiteRegistry;
  taskStore?: TaskStore;
  agentYamlStore?: AgentYamlStore;
  projectRegistry?: ProjectRegistry;
  projectsDir?: string;
}

/** Write a new agent YAML to the filesystem and reload the registry. */
async function syncYamlCreate(
  deps: Pick<AgentRouteDeps, 'agentYamlStore' | 'projectRegistry' | 'projectsDir'>,
  agent: {
    name: string;
    description: string | null;
    skills: string[];
    instructions: string | null;
    bash?: z.infer<typeof BashAccessSchema>;
  },
  projectScope?: string,
): Promise<void> {
  const { agentYamlStore, projectRegistry, projectsDir } = deps;
  if (!agentYamlStore || !projectsDir) return;
  const targetDir = projectScope ? resolve(projectsDir, projectScope) : projectsDir;
  await agentYamlStore.createAgent(targetDir, {
    name: agent.name,
    displayName: agent.name,
    description: agent.description ?? '',
    skills: agent.skills,
    instructions: agent.instructions ?? undefined,
    ...(agent.bash && { bash: agent.bash }),
  } as AgentYaml);
  if (projectRegistry) await projectRegistry.load(projectsDir);
}

/** Update an existing agent YAML on the filesystem and reload the registry. */
async function syncYamlUpdate(
  deps: Pick<AgentRouteDeps, 'agentYamlStore' | 'projectRegistry' | 'projectsDir'>,
  agent: {
    name: string;
    description: string | null;
    skills: string[];
    instructions: string | null;
    bash?: z.infer<typeof BashAccessSchema>;
  },
): Promise<void> {
  const { agentYamlStore, projectRegistry, projectsDir } = deps;
  if (!agentYamlStore || !projectsDir || !projectRegistry) return;
  const fsNode = findAgentInRegistry(projectRegistry, agent.name);
  if (!fsNode) return;
  await agentYamlStore.updateAgent(fsNode.projectPath, agent.name, {
    description: agent.description ?? '',
    skills: agent.skills,
    instructions: agent.instructions ?? undefined,
    ...(agent.bash && { bash: agent.bash }),
  });
  await projectRegistry.load(projectsDir);
}

/** Delete an agent YAML from the filesystem and reload the registry. */
async function syncYamlDelete(
  deps: Pick<AgentRouteDeps, 'agentYamlStore' | 'projectRegistry' | 'projectsDir'>,
  agentName: string,
): Promise<void> {
  const { agentYamlStore, projectRegistry, projectsDir } = deps;
  if (!agentYamlStore || !projectsDir || !projectRegistry) return;
  const fsNode = findAgentInRegistry(projectRegistry, agentName);
  if (!fsNode) return;
  await agentYamlStore.deleteAgent(fsNode.projectPath, agentName);
  await projectRegistry.load(projectsDir);
}

// eslint-disable-next-line max-lines-per-function -- route registration
export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { namedAgentStore, agentManager, suiteRegistry, taskStore } = deps;

  function getActiveAgentIds(): Set<string> {
    const activeTasks = agentManager.getActiveTasks();
    const ids = new Set<string>();
    for (const task of [...activeTasks.running, ...activeTasks.queued]) {
      if (task.namedAgentId) ids.add(task.namedAgentId);
    }
    return ids;
  }

  function enrichSuiteInfo(suiteIds: string[]): Array<{ name: string; displayName: string }> {
    return suiteIds
      .map((name) => {
        const suite = suiteRegistry.getSuite(name);
        return suite ? { name, displayName: suite.manifest.displayName } : null;
      })
      .filter((s): s is { name: string; displayName: string } => s !== null);
  }

  // GET /api/agents — list all named agents with enrichment
  app.get('/api/agents', async () => {
    const agents = namedAgentStore.listAgents();
    const activeIds = getActiveAgentIds();

    return agents.map((agent) => {
      // Count tasks assigned to this agent
      let completedCount = 0;
      let inProgressCount = 0;
      if (taskStore) {
        completedCount = taskStore.queryTasks({
          assignedAgentId: agent.id,
          status: 'completed',
        }).length;
        inProgressCount = taskStore.queryTasks({
          assignedAgentId: agent.id,
          status: 'in_progress',
        }).length;
      }

      return {
        ...agent,
        suites: enrichSuiteInfo(agent.suiteIds),
        isActive: activeIds.has(agent.id),
        taskCounts: { completed: completedCount, inProgress: inProgressCount },
      };
    });
  });

  // GET /api/agents/:id — full agent detail
  app.get('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = namedAgentStore.getAgent(id);
    if (!agent) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Agent not found' });
    }

    const activeIds = getActiveAgentIds();

    return {
      ...agent,
      suites: enrichSuiteInfo(agent.suiteIds),
      isActive: activeIds.has(agent.id),
    };
  });

  // POST /api/agents — create named agent
  app.post('/api/agents', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const projectScope = typeof body.projectScope === 'string' ? body.projectScope : undefined;

    const result = NamedAgentCreateInputSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: 'Invalid agent input',
        details: result.error.issues,
      });
    }

    try {
      const agent = namedAgentStore.createAgent(result.data);

      // Also write YAML file if filesystem backing is available
      try {
        await syncYamlCreate(
          deps,
          { ...agent, bash: result.data.bash },
          projectScope,
        );
      } catch (yamlErr) {
        log.warn(`Failed to write agent YAML for "${agent.name}": ${yamlErr}`);
      }

      return reply.status(HTTP_STATUS.OK_CREATED).send(agent);
    } catch (err) {
      const msg = (err as Error).message;
      const isUnique = msg.includes('UNIQUE constraint');
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: isUnique ? 'Agent name already exists' : msg,
      });
    }
  });

  // PATCH /api/agents/:id — update agent fields
  app.patch('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = NamedAgentUpdateInputSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: 'Invalid update input',
        details: result.error.issues,
      });
    }

    try {
      const agent = namedAgentStore.updateAgent(id, result.data);

      // Also update YAML file if filesystem backing is available
      try {
        await syncYamlUpdate(deps, { ...agent, bash: result.data.bash });
      } catch (yamlErr) {
        log.warn(`Failed to update agent YAML for "${agent.name}": ${yamlErr}`);
      }

      return agent;
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') ? HTTP_STATUS.NOT_FOUND : HTTP_STATUS.BAD_REQUEST;
      return reply.status(status).send({ error: msg });
    }
  });

  // DELETE /api/agents/:id — delete agent (400 if default)
  app.delete('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    // Look up agent name before deletion for YAML cleanup
    const existingAgent = namedAgentStore.getAgent(id);

    try {
      namedAgentStore.deleteAgent(id);

      // Also delete YAML file if filesystem backing is available
      if (existingAgent) {
        try {
          await syncYamlDelete(deps, existingAgent.name);
        } catch (yamlErr) {
          log.warn(`Failed to delete agent YAML for "${existingAgent.name}": ${yamlErr}`);
        }
      }

      return { success: true };
    } catch (err) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: (err as Error).message });
    }
  });

  // GET /api/agents/:id/tasks — paginated task history
  app.get('/api/agents/:id/tasks', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = namedAgentStore.getAgent(id);
    if (!agent) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Agent not found' });
    }

    const result = TaskHistoryQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Invalid query parameters' });
    }

    if (!taskStore) {
      return [];
    }

    return taskStore.queryTasks({
      assignedAgentId: id,
      limit: result.data.limit,
      offset: result.data.offset,
      includeArchived: true,
    });
  });
}

/**
 * Search the project registry for a project node that contains an agent with the given name.
 * Returns the project path where the agent YAML lives, or undefined if not found.
 */
function findAgentInRegistry(
  registry: ProjectRegistry,
  agentName: string,
): { projectPath: string } | undefined {
  const projects = registry.listProjects();
  // Also check the global node
  try {
    projects.unshift(registry.getGlobal());
  } catch {
    // Global may not exist
  }

  for (const project of projects) {
    const hasAgent = project.agents.some((a) => a.name === agentName);
    if (hasAgent) {
      return { projectPath: project.path };
    }
  }
  return undefined;
}
