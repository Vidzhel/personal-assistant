import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import {
  HTTP_STATUS,
  CreateProjectKnowledgeLinkSchema,
  KnowledgeProposalResponseSchema,
} from '@raven/shared';
import type { Neo4jClient } from '../../knowledge-engine/neo4j-client.ts';
import type { KnowledgeStore } from '../../knowledge-engine/knowledge-store.ts';
import type { ProjectWorkspaceStore } from '../../project-manager/project-workspace.ts';
import { registerProjectWorkspaceRoutes } from './project-workspaces.ts';
import {
  linkBubbleToProject,
  unlinkBubbleFromProject,
  getProjectKnowledgeLinks,
} from '../../knowledge-engine/project-knowledge.ts';
import { recordKnowledgeRejection } from '../../knowledge-engine/knowledge-rejections.ts';
import { getDb } from '../../db/database.ts';
import { projectRoot } from '../../config.ts';
import {
  ProjectMutationError,
  withProjectMutation,
} from '../../project-manager/project-mutation.ts';
import { isCurrentProject } from '../../project-manager/project-active.ts';
import type { ProjectRegistry } from '../../project-registry/project-registry.ts';
import type { EffectiveModelConfigResolver, ModelConfigValidator } from '../model-config-api.ts';

export interface ProjectKnowledgeRouteDeps {
  neo4j?: Neo4jClient;
  knowledgeStore?: KnowledgeStore;
  projectsDir?: string;
  projectRegistry?: ProjectRegistry;
  workspaceStore?: ProjectWorkspaceStore;
  validateModelConfig?: ModelConfigValidator;
  resolveEffectiveModelConfig?: EffectiveModelConfigResolver;
}

function assertProjectExists(projectId: string): void {
  if (!getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
    throw new ProjectMutationError('Project not found', HTTP_STATUS.NOT_FOUND);
  }
}

/** Hold the same lock as archive/delete through the entire asynchronous graph write. */
function mutateKnowledge<T>(
  deps: ProjectKnowledgeRouteDeps,
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withProjectMutation(deps.projectsDir ?? resolve(projectRoot, 'projects'), async () => {
    if (!isCurrentProject(getDb(), projectId, deps.projectRegistry)) {
      throw new ProjectMutationError('Project not found', HTTP_STATUS.NOT_FOUND);
    }
    return operation();
  });
}

// eslint-disable-next-line max-lines-per-function -- route registration
export function registerProjectKnowledgeRoutes(
  app: FastifyInstance,
  deps: ProjectKnowledgeRouteDeps,
): void {
  registerProjectWorkspaceRoutes(app, deps.workspaceStore, {
    validateModelConfig: deps.validateModelConfig,
    resolveEffectiveModelConfig: deps.resolveEffectiveModelConfig,
  });

  // --- Knowledge Links (Neo4j) ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/knowledge-links', async (req, reply) => {
    assertProjectExists(req.params.id);
    if (!deps.neo4j) {
      return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({ error: 'Neo4j not available' });
    }
    const links = await getProjectKnowledgeLinks(deps.neo4j, req.params.id);
    return reply.send(links);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/knowledge-links', async (req, reply) => {
    return mutateKnowledge(deps, req.params.id, async () => {
      if (!deps.neo4j) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({ error: 'Neo4j not available' });
      }
      const parsed = CreateProjectKnowledgeLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
      }
      const link = await linkBubbleToProject({
        neo4j: deps.neo4j,
        projectId: req.params.id,
        bubbleId: parsed.data.bubbleId,
      });
      return reply.status(HTTP_STATUS.CREATED).send(link);
    });
  });

  app.delete<{ Params: { id: string; bubbleId: string } }>(
    '/api/projects/:id/knowledge-links/:bubbleId',
    async (req, reply) => {
      return mutateKnowledge(deps, req.params.id, async () => {
        if (!deps.neo4j) {
          return reply
            .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
            .send({ error: 'Neo4j not available' });
        }
        await unlinkBubbleFromProject(deps.neo4j, req.params.id, req.params.bubbleId);
        return reply.status(HTTP_STATUS.NO_CONTENT).send();
      });
    },
  );

  // --- Knowledge Discovery Proposals ---

  app.post<{ Params: { id: string; action: string } }>(
    '/api/projects/:id/knowledge-proposals/:action',
    async (req, reply) => {
      // eslint-disable-next-line complexity -- branching on approve/reject/modify actions
      return mutateKnowledge(deps, req.params.id, async () => {
        const parsed = KnowledgeProposalResponseSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
        }

        const { action } = parsed.data;
        const projectId = req.params.id;
        const body = req.body as Record<string, unknown>;

        if (action === 'reject') {
          const contentHash = (body.contentHash as string) ?? '';
          const sessionId = (body.sessionId as string) ?? '';
          recordKnowledgeRejection({
            projectId,
            sessionId,
            contentHash,
            reason: parsed.data.reason,
          });
          return reply.send({ status: 'rejected' });
        }

        if (!deps.knowledgeStore || !deps.neo4j) {
          return reply
            .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
            .send({ error: 'Knowledge store not available' });
        }

        // approve or modify: create bubble and link to project
        const content =
          action === 'modify'
            ? (parsed.data.modifiedContent ?? '')
            : ((body.content as string) ?? '');
        const title = (body.title as string) ?? 'Discovered Knowledge';
        const tags = (body.tags as string[]) ?? [];

        const bubble = await deps.knowledgeStore.insert({
          title,
          content,
          source: `project:${projectId}`,
          tags,
        });

        await linkBubbleToProject({ neo4j: deps.neo4j, projectId, bubbleId: bubble.id });

        return reply.status(HTTP_STATUS.CREATED).send({ status: action, bubbleId: bubble.id });
      });
    },
  );
}
