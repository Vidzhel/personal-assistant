import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { ProjectWorkspaceStore } from '../../project-manager/project-workspace.ts';
import { contentDisposition } from '../../project-manager/project-files-access.ts';
import {
  createProjectFileService,
  type ProjectFileService,
} from '../../project-manager/project-files-service.ts';
import { ProjectMutationError } from '../../project-manager/project-mutation.ts';

interface FileQuery {
  sourceId?: string;
  path?: string;
  revision?: string;
}

interface ContentQuery extends FileQuery {
  download?: string;
}

function serviceError(error: unknown): ProjectMutationError {
  if (error instanceof ProjectMutationError) return error;
  return new ProjectMutationError(error instanceof Error ? error.message : String(error));
}

function queryPath(query: FileQuery): string {
  return query.path ?? '';
}

function sendError(
  error: unknown,
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
): unknown {
  const cause = serviceError(error);
  return reply.status(cause.statusCode).send({ error: cause.message });
}

function setSafeHeaders(reply: {
  header: (name: string, value: string | number) => unknown;
}): void {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', 'no-store');
  reply.header('Referrer-Policy', 'no-referrer');
}

function unavailable(reply: {
  status: (code: number) => { send: (body: unknown) => unknown };
}): unknown {
  return reply
    .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
    .send({ error: 'Project file access is unavailable' });
}

function registerListing(app: FastifyInstance, service?: ProjectFileService): void {
  app.get<{ Params: { id: string }; Querystring: FileQuery }>(
    '/api/projects/:id/files',
    async (request, reply) => {
      if (!service) return unavailable(reply);
      setSafeHeaders(reply);
      try {
        return service.list({
          projectId: request.params.id,
          sourceId: request.query.sourceId,
          path: queryPath(request.query),
          revision: request.query.revision,
        });
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
}

function registerInfo(app: FastifyInstance, service?: ProjectFileService): void {
  app.get<{ Params: { id: string }; Querystring: FileQuery }>(
    '/api/projects/:id/files/info',
    async (request, reply) => {
      if (!service) return unavailable(reply);
      setSafeHeaders(reply);
      try {
        return service.getInfo({
          projectId: request.params.id,
          sourceId: request.query.sourceId,
          path: queryPath(request.query),
          revision: request.query.revision,
        });
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
}

function registerContent(app: FastifyInstance, service?: ProjectFileService): void {
  app.get<{ Params: { id: string }; Querystring: ContentQuery }>(
    '/api/projects/:id/files/content',
    async (request, reply) => {
      if (!service) return unavailable(reply);
      const revision = request.query.revision;
      if (!revision)
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'revision is required' });
      try {
        const content = service.openContent({
          projectId: request.params.id,
          sourceId: request.query.sourceId,
          path: queryPath(request.query),
          revision,
          download: request.query.download === '1',
        });
        setSafeHeaders(reply);
        reply.header('Content-Type', content.info.mimeType);
        reply.header('Content-Length', content.info.size);
        reply.header(
          'Content-Disposition',
          contentDisposition(content.info.path, request.query.download === '1'),
        );
        if (content.info.preview === 'html' && request.query.download !== '1') {
          reply.header(
            'Content-Security-Policy',
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          );
        }
        return content.text ?? reply.send(content.stream);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
}

export function registerProjectFileRoutes(
  app: FastifyInstance,
  workspaceStore?: ProjectWorkspaceStore,
): void {
  const service = workspaceStore ? createProjectFileService(workspaceStore) : undefined;
  void app.register(async (fileApp) => {
    fileApp.setErrorHandler((error, _request, reply) => sendError(error, reply));
    registerListing(fileApp, service);
    registerInfo(fileApp, service);
    registerContent(fileApp, service);
  });
}
