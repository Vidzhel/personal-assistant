import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { registerFileRoutes } from '../api/routes/files.ts';

describe('file download API', () => {
  let app: ReturnType<typeof Fastify>;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'raven-files-test-'));
    mkdirSync(join(dataDir, 'files', 'documents'), { recursive: true });
    writeFileSync(join(dataDir, 'files', 'documents', 'test.txt'), 'hello world');

    app = Fastify();
    registerFileRoutes(app, dataDir);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves a file from data/files/', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/documents/test.txt',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('hello world');
  });

  it('returns 404 for non-existent file', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/documents/nope.txt',
    });

    expect(response.statusCode).toBe(404);
  });

  it('blocks path traversal attempts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/files/../../../etc/passwd',
    });

    expect(response.statusCode).toBe(403);
  });
});
