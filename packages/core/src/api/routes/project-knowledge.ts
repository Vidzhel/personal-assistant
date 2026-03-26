import type { FastifyInstance } from 'fastify';
import {
  HTTP_STATUS,
  CreateDataSourceSchema,
  CreateProjectKnowledgeLinkSchema,
  KnowledgeProposalResponseSchema,
} from '@raven/shared';
import type { Neo4jClient } from '../../knowledge-engine/neo4j-client.ts';
import type { KnowledgeStore } from '../../knowledge-engine/knowledge-store.ts';
import {
  createDataSource,
  getDataSources,
  getDataSource,
  updateDataSource,
  deleteDataSource,
} from '../../project-manager/project-data-sources.ts';
import {
  linkBubbleToProject,
  unlinkBubbleFromProject,
  getProjectKnowledgeLinks,
} from '../../knowledge-engine/project-knowledge.ts';
import { recordKnowledgeRejection } from '../../knowledge-engine/knowledge-rejections.ts';

export interface ProjectKnowledgeRouteDeps {
  neo4j?: Neo4jClient;
  knowledgeStore?: KnowledgeStore;
}

// eslint-disable-next-line max-lines-per-function -- route registration
export function registerProjectKnowledgeRoutes(
  app: FastifyInstance,
  deps: ProjectKnowledgeRouteDeps,
): void {
  // --- Data Sources CRUD ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/data-sources', async (req, reply) => {
    const sources = getDataSources(req.params.id);
    return reply.send(sources);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/data-sources', async (req, reply) => {
    const parsed = CreateDataSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
    }
    const ds = createDataSource(req.params.id, parsed.data);
    return reply.status(HTTP_STATUS.CREATED).send(ds);
  });

  app.put<{ Params: { id: string; dsId: string } }>(
    '/api/projects/:id/data-sources/:dsId',
    async (req, reply) => {
      const existing = getDataSource(req.params.dsId);
      if (!existing) {
        return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Data source not found' });
      }
      const parsed = CreateDataSourceSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
      }
      updateDataSource(req.params.dsId, parsed.data);
      const updated = getDataSource(req.params.dsId);
      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string; dsId: string } }>(
    '/api/projects/:id/data-sources/:dsId',
    async (req, reply) => {
      deleteDataSource(req.params.dsId);
      return reply.status(HTTP_STATUS.NO_CONTENT).send();
    },
  );

  // --- Knowledge Links (Neo4j) ---

  app.get<{ Params: { id: string } }>('/api/projects/:id/knowledge-links', async (req, reply) => {
    if (!deps.neo4j) {
      return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({ error: 'Neo4j not available' });
    }
    const links = await getProjectKnowledgeLinks(deps.neo4j, req.params.id);
    return reply.send(links);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/knowledge-links', async (req, reply) => {
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

  app.delete<{ Params: { id: string; bubbleId: string } }>(
    '/api/projects/:id/knowledge-links/:bubbleId',
    async (req, reply) => {
      if (!deps.neo4j) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({ error: 'Neo4j not available' });
      }
      await unlinkBubbleFromProject(deps.neo4j, req.params.id, req.params.bubbleId);
      return reply.status(HTTP_STATUS.NO_CONTENT).send();
    },
  );

  // --- Knowledge Discovery Proposals ---

  app.post<{ Params: { id: string; action: string } }>(
    '/api/projects/:id/knowledge-proposals/:action',
    // eslint-disable-next-line complexity -- branching on approve/reject/modify actions
    async (req, reply) => {
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
        recordKnowledgeRejection({ projectId, sessionId, contentHash, reason: parsed.data.reason });
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
    },
  );
}
