import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { closeDatabase, getDb, initDatabase } from '../db/database.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import {
  createManagedProject,
  type ProjectLifecycleDeps,
} from '../project-manager/project-lifecycle.ts';
import { syncProjectCache } from '../project-manager/project-sync.ts';
import { saveProjectRow } from '../project-manager/project-cache.ts';
import {
  readProjectRecoveryReport,
  readProjectMutationRecordsSync,
  recoverProjectMutation,
} from '../project-manager/project-recovery/journal.ts';
import { readProjectDefinition } from '../project-registry/project-definition.ts';
import type { Project } from '@raven/shared';

interface ProjectFixture {
  root: string;
  projectsDir: string;
  dbPath: string;
  projectId: string;
  projectPath: string;
  originalContext: string;
  plainProjectPath: string;
}

interface ChildMessage {
  type: 'ready' | 'error' | 'complete';
  phase?: string;
  message?: string;
}

const CHILD = resolve(import.meta.dirname, 'fixtures/project-recovery-child.ts');
async function makeFixture(): Promise<ProjectFixture> {
  const root = mkdtempSync(join(tmpdir(), 'raven-project-recovery-process-'));
  const projectsDir = join(root, 'projects');
  const dbPath = join(root, 'raven.db');
  mkdirSync(projectsDir, { recursive: true });
  initDatabase(dbPath);
  const db = getDb();
  const projectRegistry = new ProjectRegistry();
  await projectRegistry.load(projectsDir);
  const scaffoldingApi = createScaffoldingApi({
    projectsDir,
    projectRegistry,
    agentYamlStore: createAgentYamlStore(),
    syncProjects: () => {
      syncProjectCache({ db, projectRegistry });
    },
  });
  const project = await createManagedProject(
    { db, projectRegistry, scaffoldingApi, projectsDir } satisfies ProjectLifecycleDeps,
    { name: 'Process recovery project', systemAccess: 'none' },
  );
  if (!project.fsPath) throw new Error('project fixture did not receive a managed path');
  const projectPath = join(projectsDir, project.fsPath);
  const originalContext = readFileSync(join(projectPath, 'context.md'), 'utf8');
  const plainProjectPath = join(projectsDir, 'plain-project');
  mkdirSync(plainProjectPath);
  writeFileSync(join(plainProjectPath, 'context.md'), '# Plain project\n');
  await projectRegistry.load(projectsDir);
  saveProjectRow(db, {
    id: 'plain-project',
    name: 'plain-project',
    skills: [],
    systemAccess: 'none',
    isMeta: false,
    fsPath: 'plain-project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies Project);
  closeDatabase();
  return {
    root,
    projectsDir,
    dbPath,
    projectId: project.id,
    projectPath,
    originalContext,
    plainProjectPath,
  };
}

function waitForReady(
  child: ChildProcess,
  expectedPhase: string,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  stderr: () => string,
): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for child checkpoint ${expectedPhase}: ${stderr()}`));
    }, 10_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveReady();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReady(error);
    };
    const onMessage = (message: ChildMessage) => {
      if (message.type === 'ready' && message.phase === expectedPhase) {
        succeed();
      } else if (message.type === 'error') {
        fail(new Error(`${message.message ?? 'project recovery child failed'}: ${stderr()}`));
      } else if (message.type === 'complete') {
        fail(new Error(`Child completed before checkpoint ${expectedPhase}: ${stderr()}`));
      }
    };
    child.on('message', onMessage);
    void exited.then((result) => {
      fail(
        new Error(
          `Child exited before checkpoint ${expectedPhase} (code=${String(result.code)}, signal=${String(result.signal)}): ${stderr()}`,
        ),
      );
    });
    child.once('error', (error) => fail(error));
  });
}

async function killAtCheckpoint(input: {
  fixture: ProjectFixture;
  operation: 'update' | 'archive' | 'archive-plain' | 'create';
  phase: string;
  projectId?: string;
}): Promise<void> {
  const child = fork(
    CHILD,
    [
      input.fixture.projectsDir,
      input.fixture.dbPath,
      input.operation,
      input.projectId ?? input.fixture.projectId,
      input.phase,
    ],
    {
      cwd: input.fixture.root,
      execPath: process.execPath,
      execArgv: ['--experimental-strip-types'],
      env: { NODE_ENV: 'test', VITEST: 'true', PATH: process.env.PATH ?? '' },
      silent: true,
    },
  );
  let childStderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    childStderr += chunk.toString('utf8');
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    },
  );
  const closed = new Promise<void>((resolveClose) => {
    child.once('close', () => resolveClose());
  });
  try {
    await waitForReady(child, input.phase, exited, () => childStderr);
    child.kill('SIGKILL');
    const result = await exited;
    expect(result.signal).toBe('SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await closed;
  }
}

async function recoverAndSync(fixture: ProjectFixture): Promise<void> {
  const db = initDatabase(fixture.dbPath);
  const projectRegistry = new ProjectRegistry();
  await projectRegistry.load(fixture.projectsDir);
  const report = readProjectRecoveryReport(fixture.projectsDir);
  for (const entry of report.entries) {
    await recoverProjectMutation(
      {
        projectsDir: fixture.projectsDir,
        projectRegistry,
        db,
      },
      entry.mutationId,
    );
  }
  syncProjectCache({ db, projectRegistry });
  closeDatabase();
}

describe('project mutation recovery across process interruption', () => {
  let fixture: ProjectFixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('cancels an update killed before context publication and retains original bytes', async () => {
    await killAtCheckpoint({ fixture, operation: 'update', phase: 'update:before-context' });
    await recoverAndSync(fixture);

    expect(readFileSync(join(fixture.projectPath, 'context.md'), 'utf8')).toBe(
      fixture.originalContext,
    );
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);
  });

  it('completes an update killed after context publication and repairs the cache', async () => {
    await killAtCheckpoint({ fixture, operation: 'update', phase: 'update:after-context' });
    await recoverAndSync(fixture);

    const context = readProjectDefinition(
      readFileSync(join(fixture.projectPath, 'context.md'), 'utf8'),
    );
    expect(context.metadata?.displayName).toBe('Interrupted update');
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.prepare('SELECT name FROM projects WHERE id = ?').get(fixture.projectId)).toEqual({
      name: 'Interrupted update',
    });
    db.close();
  });

  it('retains an edited update as a conflict instead of discarding user bytes', async () => {
    await killAtCheckpoint({ fixture, operation: 'update', phase: 'update:after-context' });
    const edited = `${readFileSync(join(fixture.projectPath, 'context.md'), 'utf8')}owner edit\n`;
    writeFileSync(join(fixture.projectPath, 'context.md'), edited);
    const db = initDatabase(fixture.dbPath);
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(fixture.projectsDir);
    const report = readProjectRecoveryReport(fixture.projectsDir);
    expect(report.entries[0]?.state).toBe('conflict');
    await expect(
      recoverProjectMutation(
        { projectsDir: fixture.projectsDir, projectRegistry, db },
        report.entries[0]?.mutationId ?? '',
      ),
    ).rejects.toThrow('conflicts');
    closeDatabase();

    expect(readFileSync(join(fixture.projectPath, 'context.md'), 'utf8')).toBe(edited);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toHaveLength(1);
    const retained = new Database(fixture.dbPath, { readonly: true });
    expect(
      retained.prepare('SELECT name FROM projects WHERE id = ?').get(fixture.projectId),
    ).toEqual({
      name: 'Process recovery project',
    });
    retained.close();
  });

  it('recovers create mutations killed before staging, after staging, and after publication', async () => {
    await killAtCheckpoint({
      fixture,
      operation: 'create',
      phase: 'create:journal',
      projectId: 'create-journal-id',
    });
    await recoverAndSync(fixture);
    expect(existsSync(join(fixture.projectsDir, 'interrupted-create'))).toBe(false);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);

    await killAtCheckpoint({
      fixture,
      operation: 'create',
      phase: 'create:staged',
      projectId: 'create-staged-id',
    });
    const stagedJournal = readProjectMutationRecordsSync(fixture.projectsDir)[0];
    if (!stagedJournal?.preparedPath || stagedJournal.workspaceBytes === undefined)
      throw new Error('staged create journal did not retain workspace bytes');
    expect(
      readFileSync(join(fixture.projectsDir, stagedJournal.preparedPath, 'project.yaml'), 'utf8'),
    ).toBe(stagedJournal.workspaceBytes);
    await recoverAndSync(fixture);
    expect(existsSync(join(fixture.projectsDir, 'interrupted-create'))).toBe(false);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);

    await killAtCheckpoint({
      fixture,
      operation: 'create',
      phase: 'create:published',
      projectId: 'create-published-id',
    });
    await recoverAndSync(fixture);
    expect(
      readFileSync(join(fixture.projectsDir, 'interrupted-create', 'context.md'), 'utf8'),
    ).toContain('create-published-id');
    expect(existsSync(join(fixture.projectsDir, 'interrupted-create', 'project.yaml'))).toBe(true);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);
  });

  it('completes archive recovery when killed after the directory move', async () => {
    await killAtCheckpoint({ fixture, operation: 'archive', phase: 'archive:after-rename' });
    const report = readProjectRecoveryReport(fixture.projectsDir);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.state).toBe('published');
    const archivePath = report.entries[0]?.archivePath;
    if (!archivePath) throw new Error('archive recovery record has no archive path');
    await recoverAndSync(fixture);

    expect(existsSync(fixture.projectPath)).toBe(false);
    expect(existsSync(join(fixture.projectsDir, archivePath, 'context.md'))).toBe(true);
    expect(existsSync(join(fixture.projectsDir, archivePath, 'archive.json'))).toBe(true);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);
  });

  it.each(['changed', 'missing'])(
    'retains an archive when its workspace manifest is %s after the move',
    async (change) => {
      await killAtCheckpoint({ fixture, operation: 'archive', phase: 'archive:after-rename' });
      const report = readProjectRecoveryReport(fixture.projectsDir);
      const archivePath = report.entries[0]?.archivePath;
      if (!archivePath) throw new Error('archive recovery record has no archive path');
      const manifestPath = join(fixture.projectsDir, archivePath, 'project.yaml');
      const changedManifest = `${readFileSync(manifestPath, 'utf8')}# owner edit\n`;
      if (change === 'changed') writeFileSync(manifestPath, changedManifest);
      else unlinkSync(manifestPath);

      const db = initDatabase(fixture.dbPath);
      const projectRegistry = new ProjectRegistry();
      await projectRegistry.load(fixture.projectsDir);
      const changed = readProjectRecoveryReport(fixture.projectsDir);
      expect(changed.entries[0]?.state).toBe('conflict');
      await expect(
        recoverProjectMutation(
          { projectsDir: fixture.projectsDir, projectRegistry, db },
          changed.entries[0]?.mutationId ?? '',
        ),
      ).rejects.toThrow('conflicts');
      closeDatabase();

      expect(existsSync(fixture.projectPath)).toBe(false);
      if (change === 'changed') expect(readFileSync(manifestPath, 'utf8')).toBe(changedManifest);
      else expect(existsSync(manifestPath)).toBe(false);
      expect(readProjectRecoveryReport(fixture.projectsDir).entries).toHaveLength(1);
    },
  );

  it('retains unknown staged files instead of deleting a conflicted create', async () => {
    await killAtCheckpoint({
      fixture,
      operation: 'create',
      phase: 'create:staged',
      projectId: 'create-extra-file-id',
    });
    const journal = readProjectMutationRecordsSync(fixture.projectsDir)[0];
    if (!journal?.preparedPath) throw new Error('create journal has no staging path');
    const prepared = join(fixture.projectsDir, journal.preparedPath);
    const extraPath = join(prepared, 'owner-notes.txt');
    writeFileSync(extraPath, 'keep this file\n');

    const db = initDatabase(fixture.dbPath);
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(fixture.projectsDir);
    const report = readProjectRecoveryReport(fixture.projectsDir);
    expect(report.entries[0]?.state).toBe('conflict');
    await expect(
      recoverProjectMutation(
        { projectsDir: fixture.projectsDir, projectRegistry, db },
        journal.mutationId,
      ),
    ).rejects.toThrow('conflicts');
    closeDatabase();

    expect(readFileSync(extraPath, 'utf8')).toBe('keep this file\n');
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toHaveLength(1);
  });

  it('completes archive cleanup when killed after archive snapshot publication', async () => {
    await killAtCheckpoint({ fixture, operation: 'archive', phase: 'archive:after-json' });
    const report = readProjectRecoveryReport(fixture.projectsDir);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.state).toBe('published');
    await recoverAndSync(fixture);

    expect(existsSync(fixture.projectPath)).toBe(false);
    expect(readProjectRecoveryReport(fixture.projectsDir).entries).toEqual([]);
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(
      db.prepare('SELECT 1 FROM projects WHERE id = ?').get(fixture.projectId),
    ).toBeUndefined();
    db.close();
  });

  it('archives a plain-file identity with an identity-safe snapshot', async () => {
    await killAtCheckpoint({
      fixture,
      operation: 'archive-plain',
      phase: 'archive:after-json',
      projectId: 'plain-project',
    });
    const report = readProjectRecoveryReport(fixture.projectsDir);
    const archivePath = report.entries[0]?.archivePath;
    if (!archivePath) throw new Error('plain archive recovery record has no archive path');
    await recoverAndSync(fixture);
    expect(existsSync(fixture.plainProjectPath)).toBe(false);
    const snapshot = JSON.parse(
      readFileSync(join(fixture.projectsDir, archivePath, 'archive.json'), 'utf8'),
    ) as { id?: string; fsPath?: string };
    expect(snapshot).toEqual(
      expect.objectContaining({ id: 'plain-project', fsPath: 'plain-project' }),
    );
  });
});
