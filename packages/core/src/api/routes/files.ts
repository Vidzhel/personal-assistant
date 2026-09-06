import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import {
  closeOpenedFile,
  contentDisposition,
  createReadStreamFromFd,
  fileLimits,
  isInertMarkup,
  mimeForPath,
  openGlobalFile,
  PAYLOAD_TOO_LARGE,
} from '../../project-manager/project-files-access.ts';
import { ProjectMutationError } from '../../project-manager/project-mutation.ts';

function sendFailure(
  error: unknown,
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
): unknown {
  const cause =
    error instanceof ProjectMutationError
      ? error
      : new ProjectMutationError(error instanceof Error ? error.message : String(error));
  return reply.status(cause.statusCode).send({ error: cause.message });
}

export function registerFileRoutes(app: FastifyInstance, dataDir: string): void {
  const filesRoot = resolve(dataDir, 'files');

  app.get('/api/files/*', async (request, reply) => {
    const requestedPath = (request.params as Record<string, string>)['*'];
    if (!requestedPath)
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'No file path specified' });
    let opened: ReturnType<typeof openGlobalFile> | undefined;
    let handedOff = false;
    try {
      opened = openGlobalFile(filesRoot, requestedPath);
      if (!opened.stats.isFile()) {
        closeOpenedFile(opened);
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Cannot serve directories' });
      }
      if (opened.stats.size > fileLimits().maxDownloadBytes) {
        closeOpenedFile(opened);
        return reply.status(PAYLOAD_TOO_LARGE).send({ error: 'File exceeds the download limit' });
      }
      const download = isInertMarkup(requestedPath);
      const stream = createReadStreamFromFd(opened.fd, opened.stats.size);
      handedOff = true;
      return reply
        .header('Content-Type', mimeForPath(requestedPath))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('Content-Disposition', contentDisposition(requestedPath, download))
        .header('Content-Length', opened.stats.size)
        .send(stream);
    } catch (error) {
      if (opened && !handedOff) closeOpenedFile(opened);
      return sendFailure(error, reply);
    }
  });
}
