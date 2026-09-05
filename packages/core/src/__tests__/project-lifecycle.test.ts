import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config.ts';
import { join } from 'node:path';
import { createRavenTestFixture } from './fixtures/raven-fixture.ts';
import { initDatabase } from '../db/database.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import type { UserChatRejectedEvent } from '@raven/shared';
import { createReloadRegistries } from '../scaffolding/scaffold-and-activate.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import {
  readProjectDefinition,
  writeProjectDefinition,
} from '../project-registry/project-definition.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { runProjectSync, syncProjectCache } from '../project-manager/project-sync.ts';
import {
  createManagedProject,
  updateManagedProject,
  deleteManagedProject,
  type ProjectLifecycleDeps,
} from '../project-manager/project-lifecycle.ts';
import {
  getProjectRow,
  parseProjectRow,
  saveProjectRow,
} from '../project-manager/project-cache.ts';
import {
  readProjectRecoveryReport,
  recoverProjectMutation,
} from '../project-manager/project-recovery/journal.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    readdir: vi.fn(actual.readdir),
  };
});

describe('managed project lifecycle failures and legacy data', () => {
  let root: string;
  let deps: ProjectLifecycleDeps;
  beforeEach(async () => {
    loadConfig();
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir);
    vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
    vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
    root = mkdtempSync(join(tmpdir(), 'raven-lifecycle-'));
    const fixture = createRavenTestFixture(root);
    const db = initDatabase(fixture.dbPath);
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(fixture.projectsDir);
    const scaffoldingApi = createScaffoldingApi({
      projectsDir: fixture.projectsDir,
      projectRegistry,
      agentYamlStore: createAgentYamlStore(),
      syncProjects: () => {
        syncProjectCache({ db, projectRegistry });
      },
    });
    deps = { db, projectRegistry, scaffoldingApi, projectsDir: fixture.projectsDir };
    await runProjectSync(deps);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    deps.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const create = (name = 'Example') => createManagedProject(deps, { name, systemAccess: 'none' });
  const file = (path = 'example') => join(deps.projectsDir, path, 'context.md');

  it('merges an unrelated API update with current on-disk metadata and preserves unrelated YAML/body', async () => {
    const project = await create();
    const definition = readProjectDefinition(readFileSync(file(), 'utf8'));
    const body = '# Human context\r\n\r\nExact text.\r\n';
    const source = '---\n# owner comment\nowner: keep\n---\n' + body;
    writeFileSync(
      file(),
      writeProjectDefinition(source, {
        ...definition.metadata!,
        systemPrompt: 'Owner changed prompt',
        systemAccess: 'read',
        skills: ['owner-setting'],
      }),
    );
    await updateManagedProject(deps, project.id, { name: 'New display name' });
    const saved = readFileSync(file(), 'utf8');
    expect(saved).toContain('# owner comment');
    expect(saved).toContain('owner: keep');
    expect(readProjectDefinition(saved).body).toBe(body);
    expect(parseProjectRow(getProjectRow(deps.db, project.id))).toMatchObject({
      name: 'New display name',
      systemPrompt: 'Owner changed prompt',
      systemAccess: 'read',
      skills: ['owner-setting'],
      fsPath: 'example',
    });
  });

  it('uses path-derived plain-file identity and defaults across two syncs', async () => {
    mkdirSync(join(deps.projectsDir, 'legacy'));
    writeFileSync(file('legacy'), '# Legacy context\n');
    const legacy = {
      id: 'old-uuid',
      name: 'Legacy Display',
      description: 'Saved',
      systemPrompt: 'Saved prompt',
      skills: ['metadata-only'],
      systemAccess: 'read' as const,
      fsPath: 'legacy',
      createdAt: 1,
      updatedAt: 1,
    };
    saveProjectRow(deps.db, legacy);
    saveProjectRow(deps.db, {
      id: 'access-only',
      name: 'Access Only',
      skills: [],
      systemAccess: 'read',
      createdAt: 1,
      updatedAt: 1,
    });
    await deps.projectRegistry.load(deps.projectsDir);
    await runProjectSync(deps);
    await runProjectSync(deps);
    expect(parseProjectRow(getProjectRow(deps.db, 'legacy'))).toMatchObject({
      id: 'legacy',
      name: 'legacy',
      description: undefined,
      systemPrompt: undefined,
      skills: [],
      systemAccess: 'none',
      fsPath: 'legacy',
    });
    expect(() => getProjectRow(deps.db, legacy.id)).toThrow('Project not found');
    expect(() => getProjectRow(deps.db, 'access-only')).toThrow('Project not found');
    expect(readFileSync(file('legacy'), 'utf8')).toBe('# Legacy context\n');
    expect(existsSync(file('access-only'))).toBe(false);
  });

  it('invalid global metadata cannot turn a failed registry load into orphan deletion', async () => {
    saveProjectRow(deps.db, {
      id: 'unlinked',
      name: 'Unlinked',
      skills: [],
      createdAt: 1,
      updatedAt: 1,
    });
    writeFileSync(
      join(deps.projectsDir, 'context.md'),
      '---\nravenProject: {version: 1, systemAccess: admin}\n---\nBody',
    );
    await expect(deps.projectRegistry.load(deps.projectsDir)).rejects.toThrow();
    await expect(runProjectSync(deps)).rejects.toThrow();
    expect(getProjectRow(deps.db, 'unlinked')).toBeDefined();
    expect(existsSync(join(deps.projectsDir, 'unlinked'))).toBe(false);
  });

  it('keeps horizontal rules inside legacy context intact', () => {
    const body = '# Notes\n---\nsection: text\n---\nKeep body';
    expect(readProjectDefinition(body)).toEqual({ body });
    expect(readProjectDefinition(writeProjectDefinition(body, { version: 1 })).body).toBe(body);
  });

  it('accepts empty frontmatter and preserves its body', () => {
    const raw = '---\n---\nHuman context\n';
    expect(readProjectDefinition(raw)).toEqual({ body: 'Human context\n' });
    expect(
      readProjectDefinition(writeProjectDefinition(raw, { version: 1, systemPrompt: 'Extra' }))
        .body,
    ).toBe('Human context\n');
  });

  it('rejects the synthetic global path and fails on incomplete directory enumeration', async () => {
    await expect(deps.scaffoldingApi.createProject({ path: '_global' })).rejects.toThrow(
      'reserved',
    );
    mkdirSync(join(deps.projectsDir, '_global'));
    writeFileSync(file('_global'), '# Bad collision');
    await expect(deps.projectRegistry.load(deps.projectsDir)).rejects.toThrow('reserved');
    rmSync(join(deps.projectsDir, '_global'), { recursive: true });
    const originalReadDir = (await vi.importActual<typeof fs>('node:fs/promises')).readdir;
    vi.spyOn(fs, 'readdir').mockImplementation((...args: Parameters<typeof fs.readdir>) => {
      const [path] = args;
      if (path === deps.projectsDir)
        return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      return originalReadDir(...args);
    });
    await expect(deps.projectRegistry.load(deps.projectsDir)).rejects.toThrow('permission denied');
    await expect(runProjectSync(deps)).rejects.toThrow('permission denied');
  });

  it('archives a legacy identity snapshot without changing the original context bytes', async () => {
    mkdirSync(join(deps.projectsDir, 'legacy-empty'));
    const original = '# Owner context\n';
    writeFileSync(file('legacy-empty'), original);
    saveProjectRow(deps.db, {
      id: 'legacy-empty',
      name: 'Legacy',
      fsPath: 'legacy-empty',
      systemPrompt: 'DB prompt',
      systemAccess: 'read',
      skills: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await deps.projectRegistry.load(deps.projectsDir);
    await deleteManagedProject(deps, 'legacy-empty');
    const archived = readdirSync(join(deps.projectsDir, '.archive'))[0];
    const dir = join(deps.projectsDir, '.archive', archived);
    expect(readFileSync(join(dir, 'context.md'), 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(join(dir, 'archive.json'), 'utf8'))).toMatchObject({
      id: 'legacy-empty',
      fsPath: 'legacy-empty',
      systemAccess: 'none',
    });
  });

  it('rejects deletion when freshly edited file identity disagrees with the operational row', async () => {
    const project = await create();
    const original = readFileSync(file(), 'utf8');
    writeFileSync(
      file(),
      writeProjectDefinition(original, {
        ...readProjectDefinition(original).metadata!,
        id: 'someone-else',
      }),
    );
    await expect(deleteManagedProject(deps, project.id)).rejects.toThrow('identity conflicts');
    expect(existsSync(file())).toBe(true);
  });

  it.each(['update', 'delete'] as const)(
    'rejects a %s after metadata is removed from the current file',
    async (operation) => {
      const project = await create();
      writeFileSync(file(), '# Metadata removed externally\n');

      const action =
        operation === 'update'
          ? updateManagedProject(deps, project.id, { name: 'Should not apply' })
          : deleteManagedProject(deps, project.id);
      await expect(action).rejects.toThrow('identity conflicts');
      expect(existsSync(file())).toBe(true);
      expect(getProjectRow(deps.db, project.id)).toBeDefined();
      expect(existsSync(join(deps.projectsDir, '.archive'))).toBe(false);
    },
  );

  it('serializes same-slug creation and disjoint updates', async () => {
    const results = await Promise.allSettled([create('Same Name'), create('same-name')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const row = deps.db.prepare("SELECT id FROM projects WHERE fs_path = 'same-name'").get() as {
      id: string;
    };
    await Promise.all([
      updateManagedProject(deps, row.id, { name: 'Renamed' }),
      updateManagedProject(deps, row.id, { systemPrompt: 'Second patch' }),
    ]);
    expect(parseProjectRow(getProjectRow(deps.db, row.id))).toMatchObject({
      name: 'Renamed',
      systemPrompt: 'Second patch',
    });
    const topic = await createManagedProject(
      deps,
      { name: 'Same Name', systemAccess: 'none' },
      'telegram-topic',
    );
    expect(topic.fsPath).toBe('same-name-2');
  });

  it('reports auto-creation failure before a session or agent request is made', async () => {
    const eventBus = new EventBus();
    const rejected: UserChatRejectedEvent[] = [];
    const requests = vi.fn();
    eventBus.on('user:chat:rejected', (event) => rejected.push(event as UserChatRejectedEvent));
    eventBus.on('agent:task:request', requests);
    vi.spyOn(deps.scaffoldingApi, 'createProject').mockRejectedValueOnce(new Error('disk failed'));
    new Orchestrator({
      ...deps,
      eventBus,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(root, 'sessions') }),
      port: 0,
    });
    eventBus.emit({
      id: 'failed-create',
      timestamp: 1,
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId: 'new-topic', topicName: 'Topic', message: 'Hello' },
    });
    await vi.waitFor(() => expect(rejected).toHaveLength(1));
    expect(rejected[0].payload).toMatchObject({
      requestId: 'failed-create',
      projectId: 'new-topic',
      error: expect.stringContaining('disk failed'),
    });
    expect(requests).not.toHaveBeenCalled();
    expect(deps.db.prepare('SELECT * FROM sessions').all()).toEqual([]);
  });

  it('manual registry reload also refreshes API metadata from current files', async () => {
    const project = await create();
    const original = readFileSync(file(), 'utf8');
    writeFileSync(
      file(),
      writeProjectDefinition(original, {
        ...readProjectDefinition(original).metadata!,
        displayName: 'Edited externally',
      }),
    );
    const reload = createReloadRegistries({
      ...deps,
      libraryDir: join(root, 'library'),
      templateRegistry: { load: vi.fn() },
      capabilityLibrary: { load: vi.fn() },
      scheduleEngine: { reload: vi.fn() },
      syncProjects: () => {
        syncProjectCache(deps);
      },
    } as never);
    expect((await reload()).project).toBe(true);
    expect(getProjectRow(deps.db, project.id).name).toBe('Edited externally');
  });

  it('drops an unreferenced stale row without scaffolding', async () => {
    saveProjectRow(deps.db, {
      id: 'orphan-access',
      name: 'Orphan Access',
      skills: [],
      systemAccess: 'read',
      createdAt: 1,
      updatedAt: 1,
    });
    await runProjectSync(deps);
    expect(() => getProjectRow(deps.db, 'orphan-access')).toThrow('Project not found');
    expect(existsSync(file('orphan-access'))).toBe(false);
  });

  it('creates the supported third hierarchy level and rejects a fourth', async () => {
    await deps.scaffoldingApi.createProject({ path: 'first' });
    await deps.scaffoldingApi.createProject({ path: 'first/second' });
    await deps.scaffoldingApi.createProject({ path: 'first/second/third' });
    await expect(
      deps.scaffoldingApi.createProject({ path: 'first/second/third/fourth' }),
    ).rejects.toThrow('three directory levels');
    expect(existsSync(join(deps.projectsDir, 'first/second/third/fourth'))).toBe(false);
  });

  it.each(['write', 'reload', 'database'])(
    'retains a failed %s update journal and authoritative file state',
    async (kind) => {
      const project = await create();
      const original = readFileSync(file(), 'utf8');
      if (kind === 'write')
        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('write failed'));
      if (kind === 'reload')
        vi.spyOn(deps.projectRegistry, 'load').mockRejectedValueOnce(new Error('reload failed'));
      if (kind === 'database')
        deps.db.exec(
          "CREATE TRIGGER fail_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'database failed'); END",
        );
      await expect(updateManagedProject(deps, project.id, { name: 'Lost update' })).rejects.toThrow(
        'failed',
      );
      if (kind === 'write') expect(readFileSync(file(), 'utf8')).toBe(original);
      else
        expect(readProjectDefinition(readFileSync(file(), 'utf8')).metadata?.displayName).toBe(
          'Lost update',
        );
      expect(parseProjectRow(getProjectRow(deps.db, project.id)).name).toBe('Example');
      if (kind === 'database')
        expect(deps.projectRegistry.getProject('example')?.metadata?.displayName).toBe(
          'Lost update',
        );
      else
        expect(deps.projectRegistry.getProject('example')?.metadata?.displayName).toBe('Example');
      expect(readdirSync(join(deps.projectsDir, 'example'))).toEqual(['context.md']);
      const pending = readProjectRecoveryReport(deps.projectsDir).entries;
      expect(pending).toEqual([
        expect.objectContaining({
          projectId: project.id,
          state: kind === 'write' ? 'preparing' : 'published',
        }),
      ]);
      if (kind === 'database') deps.db.exec('DROP TRIGGER fail_update');
      await recoverProjectMutation(deps, pending[0].mutationId);
      syncProjectCache(deps);
      expect(getProjectRow(deps.db, project.id).name).toBe(
        kind === 'write' ? 'Example' : 'Lost update',
      );
      expect(readProjectRecoveryReport(deps.projectsDir).entries).toEqual([]);
    },
  );

  it('retains a published create when its cache write fails', async () => {
    deps.db.exec(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'insert failed'); END",
    );
    await expect(create()).rejects.toThrow('insert failed');
    expect(existsSync(file())).toBe(true);
    expect(deps.projectRegistry.getProject('example')).toBeDefined();
    deps.db.exec('DROP TRIGGER fail_insert');
    await deps.projectRegistry.load(deps.projectsDir);
    syncProjectCache(deps);
    expect(deps.db.prepare('SELECT name FROM projects WHERE fs_path = ?').get('example')).toEqual({
      name: 'Example',
    });
  });

  it.each(['move', 'snapshot', 'database', 'reload'])(
    'keeps a failed %s archive recoverable and durable',
    async (kind) => {
      const project = await create();
      const original = readFileSync(file(), 'utf8');
      if (kind === 'snapshot')
        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('snapshot failed'));
      if (kind === 'move') vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('move failed'));
      if (kind === 'reload')
        vi.spyOn(deps.projectRegistry, 'load').mockRejectedValueOnce(new Error('reload failed'));
      if (kind === 'database')
        deps.db.exec(
          "CREATE TRIGGER fail_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'delete failed'); END",
        );
      await expect(deleteManagedProject(deps, project.id)).rejects.toThrow('failed');
      const archiveRoot = join(deps.projectsDir, '.archive');
      if (kind === 'move') {
        expect(readFileSync(file(), 'utf8')).toBe(original);
        expect(readdirSync(archiveRoot)).toEqual([]);
      } else {
        expect(existsSync(file())).toBe(false);
        const archive = join(archiveRoot, readdirSync(archiveRoot)[0]);
        expect(readFileSync(join(archive, 'context.md'), 'utf8')).toBe(original);
        expect(existsSync(join(archive, 'archive.json'))).toBe(kind !== 'snapshot');
      }
      expect(getProjectRow(deps.db, project.id)).toBeDefined();
      const pending = readProjectRecoveryReport(deps.projectsDir).entries;
      expect(pending).toEqual([
        expect.objectContaining({
          projectId: project.id,
          state: kind === 'move' ? 'preparing' : 'published',
        }),
      ]);
      if (kind === 'database') deps.db.exec('DROP TRIGGER fail_delete');
      await recoverProjectMutation(deps, pending[0].mutationId);
      await deps.projectRegistry.load(deps.projectsDir);
      syncProjectCache(deps);
      expect(Boolean(deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(project.id))).toBe(
        kind === 'move',
      );
      expect(readProjectRecoveryReport(deps.projectsDir).entries).toEqual([]);
    },
  );

  it.each(['agents', 'templates', 'schedules', 'child'])(
    'rejects deletion with unparsed local %s files',
    async (folder) => {
      const project = await create();
      mkdirSync(join(deps.projectsDir, 'example', folder));
      writeFileSync(join(deps.projectsDir, 'example', folder, 'broken.yaml'), 'bad: [yaml');
      await expect(deleteManagedProject(deps, project.id)).rejects.toThrow('local definitions');
      expect(existsSync(file())).toBe(true);
    },
  );

  it('protects Telegram configuration, known graph membership and soft event history', async () => {
    const topic = await create('Topic');
    deps.db
      .prepare(
        "INSERT INTO telegram_topics(scope,key,group_id,topic_id) VALUES ('project',?,'fake-group',7)",
      )
      .run(topic.id);
    await expect(deleteManagedProject(deps, topic.id)).rejects.toThrow('telegram_topics');
    const history = await create('History');
    deps.db
      .prepare(
        "INSERT INTO events(id,type,source,project_id,payload,timestamp) VALUES ('event','test','test',?,'{}',1)",
      )
      .run(history.id);
    await expect(deleteManagedProject(deps, history.id)).rejects.toThrow('events');
    const graph = await create('Graph');
    const query = vi.fn().mockResolvedValue([{ id: 'bubble' }]);
    await expect(
      deleteManagedProject({ ...deps, neo4jClient: { query } as never }, graph.id),
    ).rejects.toThrow('linked knowledge');
    expect(query).toHaveBeenCalledOnce();
    expect(getProjectRow(deps.db, graph.id)).toBeDefined();
  });

  it('rechecks history inserted while a delete awaits the file move', async () => {
    const project = await create();
    const originalRename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
      await originalRename(source, target);
      deps.db
        .prepare(
          "INSERT INTO events(id,type,source,project_id,payload,timestamp) VALUES ('race','test','test',?,'{}',1)",
        )
        .run(project.id);
    });
    await expect(deleteManagedProject(deps, project.id)).rejects.toThrow('events');
    expect(existsSync(file())).toBe(false);
    expect(getProjectRow(deps.db, project.id)).toBeDefined();
    const pending = readProjectRecoveryReport(deps.projectsDir).entries;
    await expect(recoverProjectMutation(deps, pending[0].mutationId)).rejects.toThrow('references');
    expect(readProjectRecoveryReport(deps.projectsDir).entries).toHaveLength(1);
  });

  it('retains edits made while archive checks graph references', async () => {
    const project = await create();
    const edited = `${readFileSync(file(), 'utf8')}Owner edit during graph query\n`;
    const query = vi.fn(async () => {
      writeFileSync(file(), edited);
      return [];
    });
    await expect(
      deleteManagedProject({ ...deps, neo4jClient: { query } as never }, project.id),
    ).rejects.toThrow('context changed');
    expect(readFileSync(file(), 'utf8')).toBe(edited);
    expect(getProjectRow(deps.db, project.id).name).toBe('Example');
    expect(readProjectRecoveryReport(deps.projectsDir).entries).toEqual([
      expect.objectContaining({ projectId: project.id, state: 'conflict' }),
    ]);
  });

  it('rejects reserved paths, existing unindexed directories and symlink archive/context destinations', async () => {
    for (const name of ['Agents', 'Templates', 'Schedules', 'System', 'Meta'])
      await expect(create(name)).rejects.toThrow();
    mkdirSync(join(deps.projectsDir, 'unindexed'));
    writeFileSync(join(deps.projectsDir, 'unindexed', 'owner'), 'unchanged');
    await expect(create('Unindexed')).rejects.toThrow('already exists');
    const project = await create();
    symlinkSync(join(root, 'external'), join(deps.projectsDir, '.archive'));
    await expect(deleteManagedProject(deps, project.id)).rejects.toThrow('symlinks');
    rmSync(file());
    const external = join(root, 'external-context');
    writeFileSync(external, 'Owner');
    symlinkSync(external, file());
    await expect(updateManagedProject(deps, project.id, { name: 'Unsafe' })).rejects.toThrow(
      'symlinks',
    );
    expect(readFileSync(external, 'utf8')).toBe('Owner');
  });
});
