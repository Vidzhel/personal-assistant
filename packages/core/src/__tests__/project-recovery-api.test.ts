import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectMetadata } from '@raven/shared';
import { initDatabase, getDb, closeDatabase } from '../db/database.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { writeProjectDefinition } from '../project-registry/project-definition.ts';
import {
  createMutationJournal,
  readProjectRecoveryReport,
} from '../project-manager/project-recovery/journal.ts';
import {
  readProjectRecoveryDiagnostics,
  unavailableProjectMutationPaths,
} from '../project-manager/project-recovery/diagnostics.ts';
import { syncProjectCache } from '../project-manager/project-sync.ts';
import { registerProjectRecoveryRoutes } from '../api/routes/project-recovery.ts';
import type { ApiDeps } from '../api/server.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';

const fakeBackend: AgentBackend = async (options) => {
  options.onAssistantMessage('ok');
  return { sessionId: 'recovery-api-test', result: 'ok', success: true, errors: [] };
};

function metadata(id: string, displayName: string): ProjectMetadata {
  return {
    version: 1,
    id,
    displayName,
    description: `${displayName} description`,
    skills: [],
    systemAccess: 'none',
  };
}

function errorHandler(app: ReturnType<typeof Fastify>): void {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    void reply.status(statusCode).send({ error: error.message });
  });
}

describe('project recovery API', () => {
  let tmpDir: string;
  let projectsDir: string;
  let projectRegistry: ProjectRegistry;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-project-recovery-api-'));
    const fixture = createRavenTestFixture(tmpDir);
    projectsDir = fixture.projectsDir;
    initDatabase(fixture.dbPath);
    projectRegistry = new ProjectRegistry({
      getUnavailableProjectPaths: () => unavailableProjectMutationPaths(projectsDir),
    });
    await projectRegistry.load(projectsDir);

    app = Fastify({ logger: false });
    errorHandler(app);
    registerProjectRecoveryRoutes(app, {
      projectsDir,
      projectRegistry,
      getProjectRecoveryDiagnostics: () => readProjectRecoveryDiagnostics(projectsDir),
    } as unknown as ApiDeps);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function preparePublishedUpdate(displayName: string): Promise<{
    id: string;
    path: string;
    contextPath: string;
    originalBytes: string;
    intendedBytes: string;
    mutationId: string;
  }> {
    const path = `recovery-${randomUUID().slice(0, 8)}`;
    const id = `project-${path}`;
    const contextPath = join(projectsDir, path, 'context.md');
    mkdirSync(join(projectsDir, path), { recursive: true });
    const originalBytes = writeProjectDefinition(`# ${path}\n`, metadata(id, `${path} old`));
    writeFileSync(contextPath, originalBytes);
    await projectRegistry.load(projectsDir);
    syncProjectCache({ db: getDb(), projectRegistry });

    const intendedBytes = writeProjectDefinition(originalBytes, metadata(id, displayName));
    const journal = createMutationJournal({
      projectsDir,
      operation: 'update',
      projectId: id,
      path,
      originalBytes,
      intendedBytes,
    });
    writeFileSync(contextPath, intendedBytes);
    return { id, path, contextPath, originalBytes, intendedBytes, mutationId: journal.mutationId };
  }

  it('returns a sanitized report and recovers a published update into registry and SQLite', async () => {
    const pending = await preparePublishedUpdate('Recovered from the API');
    expect(projectRegistry.getProject(pending.path)).toBeUndefined();
    expect(
      (
        getDb().prepare('SELECT name FROM projects WHERE id = ?').get(pending.id) as {
          name: string;
        }
      ).name,
    ).toBe(`${pending.path} old`);

    const report = await app.inject({ method: 'GET', url: '/api/project-recovery' });
    expect(report.statusCode).toBe(200);
    const reportBody = report.json() as {
      entries: Array<Record<string, unknown>>;
      pendingProjectPaths: string[];
    };
    const entry = reportBody.entries.find(
      (candidate) => candidate.mutationId === pending.mutationId,
    );
    expect(entry).toMatchObject({
      mutationId: pending.mutationId,
      operation: 'update',
      projectId: pending.id,
      path: pending.path,
      state: 'published',
    });
    expect(reportBody.pendingProjectPaths).toContain(pending.path);
    expect(entry).not.toHaveProperty('originalBytes');
    expect(entry).not.toHaveProperty('intendedBytes');

    const recovered = await app.inject({
      method: 'POST',
      url: `/api/project-recovery/${pending.mutationId}/recover`,
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      mutationId: pending.mutationId,
      status: 'completed',
      operation: 'update',
      projectId: pending.id,
    });
    expect(readProjectRecoveryReport(projectsDir).entries).toHaveLength(0);
    expect(readProjectRecoveryDiagnostics(projectsDir)).toEqual([]);
    expect(projectRegistry.getProject(pending.path)).toBeDefined();
    expect(projectRegistry.getProject(pending.path)?.metadata?.displayName).toBe(
      'Recovered from the API',
    );
    expect(
      getDb().prepare('SELECT name, fs_path FROM projects WHERE id = ?').get(pending.id) as {
        name: string;
        fs_path: string;
      },
    ).toMatchObject({ name: 'Recovered from the API', fs_path: pending.path });
  });

  it('keeps conflicting files, journal, and cache when recovery returns 409', async () => {
    const pending = await preparePublishedUpdate('Intended value');
    expect(projectRegistry.getProject(pending.path)).toBeUndefined();
    const conflict = writeProjectDefinition(
      pending.originalBytes,
      metadata(pending.id, 'Edited while Raven was stopped'),
    );
    writeFileSync(pending.contextPath, conflict);

    const response = await app.inject({
      method: 'POST',
      url: `/api/project-recovery/${pending.mutationId}/recover`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('conflicts');
    expect(readFileSync(pending.contextPath, 'utf8')).toBe(conflict);
    expect(readProjectRecoveryReport(projectsDir).entries).toEqual([
      expect.objectContaining({ mutationId: pending.mutationId, state: 'conflict' }),
    ]);
    expect(
      (
        getDb().prepare('SELECT name FROM projects WHERE id = ?').get(pending.id) as {
          name: string;
        }
      ).name,
    ).toBe(`${pending.path} old`);
  });

  it('returns 503 when project definition dependencies are unavailable', async () => {
    const unavailable = Fastify({ logger: false });
    errorHandler(unavailable);
    registerProjectRecoveryRoutes(unavailable, {} as ApiDeps);
    await unavailable.ready();
    const response = await unavailable.inject({ method: 'GET', url: '/api/project-recovery' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('storage is unavailable');
    await unavailable.close();
  });

  it('reports failed definition reloads as a conflict', async () => {
    const reload = Fastify({ logger: false });
    errorHandler(reload);
    registerProjectRecoveryRoutes(reload, {
      reloadRegistries: async () => ({
        project: false,
        template: true,
        library: true,
        schedule: true,
      }),
    } as unknown as ApiDeps);
    await reload.ready();
    const response = await reload.inject({ method: 'POST', url: '/api/definitions/reload' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ result: { project: false } });
    await reload.close();
  });

  it('recovers an interrupted published update before composed startup syncs the cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-project-recovery-startup-'));
    let raven: RavenInstance | undefined;
    try {
      const fixture = createRavenTestFixture(root);
      const registry = new ProjectRegistry();
      await registry.load(fixture.projectsDir);
      const path = 'startup-recovery';
      const id = 'project-startup-recovery';
      const contextPath = join(fixture.projectsDir, path, 'context.md');
      mkdirSync(join(fixture.projectsDir, path), { recursive: true });
      const originalBytes = writeProjectDefinition('# Startup\n', metadata(id, 'Before restart'));
      writeFileSync(contextPath, originalBytes);
      await registry.load(fixture.projectsDir);
      const db = initDatabase(fixture.dbPath);
      syncProjectCache({ db, projectRegistry: registry });
      const intendedBytes = writeProjectDefinition(
        originalBytes,
        metadata(id, 'Recovered before cache reconciliation'),
      );
      const journal = createMutationJournal({
        projectsDir: fixture.projectsDir,
        operation: 'update',
        projectId: id,
        path,
        originalBytes,
        intendedBytes,
      });
      writeFileSync(contextPath, intendedBytes);
      closeDatabase();

      raven = await createRaven(buildTestConfig(), {
        ...fixture,
        agentBackend: fakeBackend,
        skipSuites: true,
      });
      expect(readProjectRecoveryReport(fixture.projectsDir).entries).toHaveLength(0);
      expect(
        raven.db.get<{ name: string; fs_path: string }>(
          'SELECT name, fs_path FROM projects WHERE id = ?',
          id,
        ) as { name: string; fs_path: string },
      ).toMatchObject({ name: 'Recovered before cache reconciliation', fs_path: path });
      expect(journal.mutationId).toMatch(/[0-9a-f-]{36}/);
    } finally {
      if (raven) await raven.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
