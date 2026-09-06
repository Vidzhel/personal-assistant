import type { FastifyInstance } from 'fastify';
import {
  CreateDataSourceSchema,
  UpdateDataSourceSchema,
  HTTP_STATUS,
  WorkspaceUpdateSchema,
} from '@raven/shared';
import type { ProjectWorkspaceStore } from '../../project-manager/project-workspace.ts';
import { ProjectMutationError } from '../../project-manager/project-mutation.ts';
import {
  effectiveModelConfigProjection,
  type EffectiveModelConfigResolver,
  type ModelConfigValidator,
} from '../model-config-api.ts';

interface ModelConfigRouteDeps {
  validateModelConfig?: ModelConfigValidator;
  resolveEffectiveModelConfig?: EffectiveModelConfigResolver;
}

function requireStore(store?: ProjectWorkspaceStore): ProjectWorkspaceStore {
  if (!store) {
    throw new ProjectMutationError(
      'Project workspaces are unavailable',
      HTTP_STATUS.SERVICE_UNAVAILABLE,
    );
  }
  return store;
}

function registerSourceWrites(app: FastifyInstance, store?: ProjectWorkspaceStore): void {
  app.post<{ Params: { id: string } }>('/api/projects/:id/data-sources', async (req, reply) => {
    const workspace = requireStore(store);
    workspace.getWorkspace(req.params.id);
    const parsed = CreateDataSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
    }
    const source = await workspace.createDataSource(req.params.id, parsed.data);
    return reply.status(HTTP_STATUS.CREATED).send(source);
  });
  app.put<{ Params: { id: string; dsId: string } }>(
    '/api/projects/:id/data-sources/:dsId',
    async (req, reply) => {
      const workspace = requireStore(store);
      if (!workspace.getDataSource(req.params.id, req.params.dsId)) {
        throw new ProjectMutationError('Data source not found', HTTP_STATUS.NOT_FOUND);
      }
      const parsed = UpdateDataSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
      }
      return workspace.updateDataSource(req.params.id, req.params.dsId, parsed.data);
    },
  );
  app.delete<{ Params: { id: string; dsId: string } }>(
    '/api/projects/:id/data-sources/:dsId',
    async (req, reply) => {
      await requireStore(store).deleteDataSource(req.params.id, req.params.dsId);
      return reply.status(HTTP_STATUS.NO_CONTENT).send();
    },
  );
}

function registerWorkspaceReads(
  app: FastifyInstance,
  store: ProjectWorkspaceStore | undefined,
  modelConfigDeps: ModelConfigRouteDeps,
): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/data-sources', async (req) => {
    return requireStore(store).getDataSources(req.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/workspace', async (req) => {
    const workspace = requireStore(store).getWorkspace(req.params.id);
    return {
      ...workspace,
      ...effectiveModelConfigProjection(modelConfigDeps.resolveEffectiveModelConfig, {
        projectId: req.params.id,
      }),
    };
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/workspace', async (req, reply) => {
    const workspace = requireStore(store);
    workspace.getWorkspace(req.params.id);
    const parsed = WorkspaceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
    }
    if (parsed.data.execution?.modelConfig !== undefined) {
      try {
        await modelConfigDeps.validateModelConfig?.(parsed.data.execution.modelConfig, {
          projectId: req.params.id,
        });
      } catch (error) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const updated = await workspace.updateWorkspace(req.params.id, parsed.data);
    return {
      ...updated,
      ...effectiveModelConfigProjection(modelConfigDeps.resolveEffectiveModelConfig, {
        projectId: req.params.id,
        project: updated.execution.modelConfig ?? null,
      }),
    };
  });
  registerSourceWrites(app, store);
}

export function registerProjectWorkspaceRoutes(
  app: FastifyInstance,
  store?: ProjectWorkspaceStore,
  modelConfigDeps: ModelConfigRouteDeps = {},
): void {
  void app.register(async (workspaceApp) => {
    workspaceApp.setErrorHandler((error, _request, reply) => {
      if (error instanceof ProjectMutationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      return reply.send(error);
    });
    registerWorkspaceReads(workspaceApp, store, modelConfigDeps);
  });
}
