import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '@raven/shared';
import type { ApiDeps } from '../api/server.ts';
import { registerProjectWorkspaceRoutes } from '../api/routes/project-workspaces.ts';
import { registerSessionRoutes } from '../api/routes/sessions.ts';
import { closeDatabase, getDb, initDatabase } from '../db/database.ts';
import { createProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createRavenTestFixture } from './fixtures/raven-fixture.ts';

describe('model configuration persistence APIs', () => {
  let root: string;
  let app: ReturnType<typeof Fastify>;
  let sessions: SessionManager;
  let activeSessionId: string;
  let historicalSessionId: string;
  let effectiveError: string | undefined;
  const validations: Array<{
    config: ModelConfig | null;
    context: { projectId: string; sessionId?: string };
  }> = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-model-config-api-'));
    const fixture = createRavenTestFixture(root);
    const projectDirectory = join(fixture.projectsDir, 'alpha');
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(join(projectDirectory, 'context.md'), '# Alpha\n');
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(fixture.projectsDir);
    const workspaceStore = createProjectWorkspaceStore({
      projectsDir: fixture.projectsDir,
      projectRegistry,
      projectRoot: root,
    });

    initDatabase(fixture.dbPath);
    const now = Date.now();
    getDb()
      .prepare(
        'INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('alpha', 'Alpha', '[]', 'alpha', now, now);
    getDb()
      .prepare(
        'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('historical', 'Historical', '[]', now, now);
    sessions = new SessionManager();
    activeSessionId = sessions.createSession('alpha').id;
    historicalSessionId = sessions.createSession('historical').id;

    const validateModelConfig = vi.fn(
      (config: ModelConfig | null, context: { projectId: string; sessionId?: string }) => {
        validations.push({ config, context });
        if (config?.model === 'unsupported-model') throw new Error('Unsupported model selection');
      },
    );
    const resolveEffectiveModelConfig = vi.fn(
      (context: { projectId: string; sessionId?: string }): ModelConfig => {
        if (effectiveError) throw new Error(effectiveError);
        return context.sessionId
          ? { model: 'effective-session', effort: 'medium' }
          : { model: 'effective-project', effort: 'low' };
      },
    );

    app = Fastify();
    registerSessionRoutes(app, {
      sessionManager: sessions,
      projectRegistry,
      validateModelConfig,
      resolveEffectiveModelConfig,
    } as unknown as ApiDeps);
    registerProjectWorkspaceRoutes(app, workspaceStore, {
      validateModelConfig,
      resolveEffectiveModelConfig,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
    validations.length = 0;
  });

  it('validates and atomically replaces or resets a session override', async () => {
    const selected = { model: 'claude-sonnet-4-6', effort: 'high' as const };
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${activeSessionId}`,
      payload: { modelConfig: selected },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      modelConfig: selected,
      effectiveModelConfig: { model: 'effective-session', effort: 'medium' },
    });
    expect(validations.at(-1)).toEqual({
      config: selected,
      context: { projectId: 'alpha', sessionId: activeSessionId },
    });

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${activeSessionId}`,
      payload: { modelConfig: { model: 'unsupported-model' } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: 'Unsupported model selection' });
    expect(sessions.getSession(activeSessionId)?.modelConfig).toEqual(selected);

    effectiveError = 'Catalog unavailable';
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${activeSessionId}` });
    expect(read.json()).toMatchObject({
      modelConfig: selected,
      modelConfigError: 'Catalog unavailable',
    });
    expect(read.json()).not.toHaveProperty('effectiveModelConfig');
    effectiveError = undefined;

    const reset = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${activeSessionId}`,
      payload: { modelConfig: null },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).not.toHaveProperty('modelConfig');
    expect(validations.at(-1)?.config).toBeNull();
  });

  it('rejects malformed overrides and checks current ownership before validation or writes', async () => {
    const malformed = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${activeSessionId}`,
      payload: { modelConfig: { effort: 'extreme', secret: true } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(validations).toEqual([]);

    const historical = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${historicalSessionId}`,
      payload: { modelConfig: { effort: 'high' } },
    });
    expect(historical.statusCode).toBe(404);
    expect(validations).toEqual([]);
    expect(sessions.getSession(historicalSessionId)?.modelConfig).toBeUndefined();
  });

  it('persists project defaults through the workspace lifecycle and reports resolver errors', async () => {
    const selected = { model: 'claude-opus-4-1', thinking: 'adaptive' as const };
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/projects/alpha/workspace',
      payload: { execution: { modelConfig: selected } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      execution: { mode: 'default', modelConfig: selected },
      effectiveModelConfig: { model: 'effective-project', effort: 'low' },
    });
    expect(validations.at(-1)).toEqual({ config: selected, context: { projectId: 'alpha' } });

    const manifest = join(root, 'projects', 'alpha', 'project.yaml');
    const beforeRejected = readFileSync(manifest, 'utf8');
    expect(beforeRejected).not.toContain('effectiveModelConfig');
    expect(beforeRejected).not.toContain('modelConfigError');
    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/projects/alpha/workspace',
      payload: { execution: { modelConfig: { model: 'unsupported-model' } } },
    });
    expect(rejected.statusCode).toBe(400);
    expect(readFileSync(manifest, 'utf8')).toBe(beforeRejected);

    effectiveError = 'Catalog unavailable';
    const read = await app.inject({ method: 'GET', url: '/api/projects/alpha/workspace' });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      execution: { modelConfig: selected },
      modelConfigError: 'Catalog unavailable',
    });
    expect(read.json()).not.toHaveProperty('effectiveModelConfig');

    effectiveError = undefined;
    const reset = await app.inject({
      method: 'PUT',
      url: '/api/projects/alpha/workspace',
      payload: { execution: { modelConfig: null } },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().execution).not.toHaveProperty('modelConfig');
  });
});
