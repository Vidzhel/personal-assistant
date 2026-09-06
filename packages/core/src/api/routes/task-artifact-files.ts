import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS, META_PROJECT_ID, type TaskArtifact } from '@raven/shared';
import type { TaskExecutionEngine } from '../../task-execution/task-execution-engine.ts';
import type { ProjectWorkspaceStore } from '../../project-manager/project-workspace.ts';
import {
  createProjectFileService,
  type ProjectFileInfo,
} from '../../project-manager/project-files-service.ts';
import { locateTaskArtifact } from '../../project-manager/task-artifact-files.ts';
import { ProjectMutationError } from '../../project-manager/project-mutation.ts';

interface ArtifactParams {
  id: string;
  taskId: string;
  index: string;
}

interface ArtifactDeps {
  executionEngine: TaskExecutionEngine;
  workspaceStore?: ProjectWorkspaceStore;
}

function storedArtifact(
  params: ArtifactParams,
  deps: ArtifactDeps,
): { projectId: string; artifact: TaskArtifact } {
  if (!/^\d+$/.test(params.index) || !Number.isSafeInteger(Number(params.index))) {
    throw new ProjectMutationError('Invalid artifact index', HTTP_STATUS.BAD_REQUEST);
  }
  const tree = deps.executionEngine.getTree(params.id);
  const artifact = tree?.tasks.get(params.taskId)?.artifacts[Number(params.index)];
  if (!tree || !artifact || artifact.type !== 'file' || !artifact.filePath) {
    throw new ProjectMutationError('File artifact not found', HTTP_STATUS.NOT_FOUND);
  }
  return { projectId: tree.projectId ?? META_PROJECT_ID, artifact };
}

function artifactInfo(params: ArtifactParams, deps: ArtifactDeps): ProjectFileInfo {
  const { projectId, artifact } = storedArtifact(params, deps);
  if (!deps.workspaceStore) {
    throw new ProjectMutationError(
      'Project files are unavailable',
      HTTP_STATUS.SERVICE_UNAVAILABLE,
    );
  }
  if (!artifact.sourceId && !isAbsolute(artifact.filePath ?? '')) {
    throw new ProjectMutationError(
      'This artifact has no saved source; register it with a sourceId',
    );
  }
  const location = locateTaskArtifact({
    artifact,
    projectId,
    workspaceStore: deps.workspaceStore,
  });
  const info = createProjectFileService(deps.workspaceStore).getInfo(location);
  if (info.type !== 'file') throw new ProjectMutationError('The artifact is no longer a file');
  return info;
}

export function registerTaskArtifactFileRoutes(app: FastifyInstance, deps: ArtifactDeps): void {
  app.get<{ Params: ArtifactParams }>(
    '/api/task-trees/:id/tasks/:taskId/artifacts/:index/file',
    async (request, reply) => {
      try {
        return artifactInfo(request.params, deps);
      } catch (error) {
        if (error instanceof ProjectMutationError) {
          return reply.status(error.statusCode).send({ error: error.message });
        }
        return reply.status(HTTP_STATUS.CONFLICT).send({
          error: error instanceof Error ? error.message : 'File artifact is unavailable',
        });
      }
    },
  );
}
