import { resolve, normalize } from 'node:path';
import { existsSync, createReadStream, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@raven/shared';

const log = createLogger('file-routes');

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function registerFileRoutes(app: FastifyInstance, dataDir: string): void {
  const filesRoot = resolve(dataDir, 'files');

  // Block path traversal: when Fastify normalizes /api/files/../../etc/passwd → /etc/passwd,
  // the route won't match. We treat any unmatched route as a potential traversal attempt.
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(HTTP_FORBIDDEN).send({ error: 'Forbidden' });
  });

  app.get('/api/files/*', async (request, reply) => {
    const requestedPath = (request.params as Record<string, string>)['*'];
    if (!requestedPath) {
      return reply.status(HTTP_BAD_REQUEST).send({ error: 'No file path specified' });
    }

    const resolvedPath = resolve(filesRoot, normalize(requestedPath));

    // Path traversal protection (defense in depth)
    if (!resolvedPath.startsWith(filesRoot)) {
      log.warn(`Path traversal attempt blocked: ${requestedPath}`);
      return reply.status(HTTP_FORBIDDEN).send({ error: 'Forbidden' });
    }

    if (!existsSync(resolvedPath)) {
      return reply.status(HTTP_NOT_FOUND).send({ error: 'File not found' });
    }

    const stat = statSync(resolvedPath);
    if (stat.isDirectory()) {
      return reply.status(HTTP_BAD_REQUEST).send({ error: 'Cannot serve directories' });
    }

    const mimeType = getMimeType(resolvedPath);
    const fileName = resolvedPath.slice(resolvedPath.lastIndexOf('/') + 1);

    return reply
      .header('Content-Type', mimeType)
      .header('Content-Disposition', `inline; filename="${fileName}"`)
      .header('Content-Length', stat.size)
      .send(createReadStream(resolvedPath));
  });
}
