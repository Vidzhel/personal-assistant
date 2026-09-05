import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createProjectMemoryFixture } from './fixtures/project-memory.ts';
import { registerProjectMemoryRoutes } from '../api/routes/project-memory.ts';

describe('project memory HTTP route', () => {
  let root: string;
  let projectsDir: string;
  let app: ReturnType<typeof Fastify>;
  let memoryStore: Awaited<ReturnType<typeof createProjectMemoryFixture>>['memoryStore'];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-project-memory-api-'));
    projectsDir = join(root, 'projects');
    const fixture = await createProjectMemoryFixture(projectsDir, ['alpha', 'beta']);
    memoryStore = fixture.memoryStore;
    app = Fastify({ logger: false });
    registerProjectMemoryRoutes(app, memoryStore);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns nested project notes with isolation between projects', async () => {
    await memoryStore.write('alpha', 'research/private.md', 'alpha-only');
    await memoryStore.write('beta', 'research/private.md', 'beta-only');

    const alpha = await app.inject({ method: 'GET', url: '/api/projects/alpha/memory' });
    const beta = await app.inject({ method: 'GET', url: '/api/projects/beta/memory' });

    expect(alpha.statusCode).toBe(200);
    expect(alpha.json()).toContainEqual({ file: 'research/private.md', content: 'alpha-only' });
    expect(JSON.stringify(alpha.json())).not.toContain('beta-only');
    expect(beta.json()).toContainEqual({ file: 'research/private.md', content: 'beta-only' });
    expect(JSON.stringify(beta.json())).not.toContain('alpha-only');
  });

  it('returns 404 for an unknown project', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/projects/missing/memory' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatch(/project not found/i);
  });

  it('returns 409 when the project workspace is malformed', async () => {
    writeFileSync(join(projectsDir, 'alpha', 'project.yaml'), 'sources: [');
    const response = await app.inject({ method: 'GET', url: '/api/projects/alpha/memory' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/workspace/i);
  });

  it('returns 503 when the memory store is unavailable', async () => {
    const unavailable = Fastify({ logger: false });
    registerProjectMemoryRoutes(unavailable);
    await unavailable.ready();
    const response = await unavailable.inject({ method: 'GET', url: '/api/projects/alpha/memory' });
    await unavailable.close();
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/memory store not available/i);
  });

  it('returns a truthful error for a symlinked memory note', async () => {
    await memoryStore.write('alpha', 'safe.md', 'safe');
    symlinkSync(join(root, 'outside.md'), join(projectsDir, 'alpha', 'memory', 'unsafe.md'));
    const response = await app.inject({ method: 'GET', url: '/api/projects/alpha/memory' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/symlink/i);
    expect(response.json()).not.toHaveProperty('safe');
  });

  it('does not expose the removed agent memory route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/agents/raven/memory' });
    expect(response.statusCode).toBe(404);
  });
});
