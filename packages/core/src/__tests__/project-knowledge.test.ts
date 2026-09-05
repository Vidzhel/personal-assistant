import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import {
  createProjectWorkspaceStore,
  type ProjectWorkspaceStore,
} from '../project-manager/project-workspace.ts';
import { type CreateDataSourceInput } from '@raven/shared';
import {
  recordKnowledgeRejection,
  isContentRejected,
} from '../knowledge-engine/knowledge-rejections.ts';
import {
  syncProjectNodes,
  linkBubbleToProject,
  unlinkBubbleFromProject,
  getProjectKnowledgeLinks,
  getProjectsForBubble,
} from '../knowledge-engine/project-knowledge.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { buildSystemPrompt } from '../agent-manager/prompt-builder.ts';
import { SKILL_ORCHESTRATOR, type AgentTask } from '@raven/shared';

const PROJECT_ID = 'proj-test-1';

function createMockNeo4j(): Neo4jClient {
  return {
    run: vi.fn().mockResolvedValue({ records: [] }),
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn().mockImplementation(async (fn: any) => fn({ run: vi.fn() })),
    ensureSchema: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Project Knowledge (10.9)', () => {
  let tmpDir: string;
  let projectsDir: string;
  let workspaceStore: ProjectWorkspaceStore;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'project-knowledge-'));
    projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    for (const id of [PROJECT_ID, 'proj-test-2', 'proj-ctx', 'proj-empty']) {
      const projectDir = join(projectsDir, id);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'context.md'), `# ${id}\n`);
      writeFileSync(
        join(projectDir, 'project.yaml'),
        'version: 1\nexecution:\n  mode: default\nsources: []\n',
      );
    }
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    workspaceStore = createProjectWorkspaceStore({
      projectsDir,
      projectRegistry,
      projectRoot: tmpDir,
    });
    initDatabase(join(tmpDir, 'test.db'));

    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(PROJECT_ID, 'Test Project', '', '[]', now, now);
    db.prepare(
      'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('proj-test-2', 'Second Project', '', '[]', now, now);
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Data Source CRUD (project.yaml)', () => {
    const sourceInput: CreateDataSourceInput = {
      uri: 'https://docs.google.com/spreadsheets/d/abc',
      label: 'Budget Sheet',
      description: 'Monthly budget tracking',
      sourceType: 'gdrive',
    };

    it('creates and retrieves a data source', async () => {
      const ds = await workspaceStore.createDataSource(PROJECT_ID, sourceInput);

      expect(ds.id).toBeDefined();
      expect(ds.projectId).toBe(PROJECT_ID);
      expect(ds.uri).toBe('https://docs.google.com/spreadsheets/d/abc');
      expect(ds.label).toBe('Budget Sheet');
      expect(ds.sourceType).toBe('gdrive');

      const fetched = workspaceStore.getDataSource(PROJECT_ID, ds.id);
      expect(fetched).toBeDefined();
      expect(fetched!.label).toBe('Budget Sheet');
      expect(readFileSync(join(projectsDir, PROJECT_ID, 'project.yaml'), 'utf8')).toContain(ds.id);
    });

    it('lists data sources scoped to project', async () => {
      await workspaceStore.createDataSource('proj-test-2', {
        uri: '/tmp/notes.txt',
        label: 'Notes',
        sourceType: 'file',
      });

      const sources = workspaceStore.getDataSources(PROJECT_ID);
      expect(sources.every((s) => s.projectId === PROJECT_ID)).toBe(true);
    });

    it('updates a data source', async () => {
      const ds = await workspaceStore.createDataSource(PROJECT_ID, {
        uri: 'https://example.com',
        label: 'Example',
        sourceType: 'url',
      });

      const updated = await workspaceStore.updateDataSource(PROJECT_ID, ds.id, {
        label: 'Updated Example',
        description: 'New desc',
      });
      expect(updated.label).toBe('Updated Example');
      expect(updated.description).toBe('New desc');
    });

    it('deletes a data source', async () => {
      const ds = await workspaceStore.createDataSource(PROJECT_ID, {
        uri: 'https://delete.me',
        label: 'To Delete',
        sourceType: 'url',
      });

      await workspaceStore.deleteDataSource(PROJECT_ID, ds.id);
      expect(workspaceStore.getDataSource(PROJECT_ID, ds.id)).toBeUndefined();
    });

    it('retains sources after a store restart', async () => {
      const ds = await workspaceStore.createDataSource(PROJECT_ID, {
        uri: '/data/logs.csv',
        label: 'Log Data',
        sourceType: 'file',
      });
      const restartedRegistry = new ProjectRegistry();
      await restartedRegistry.load(projectsDir);
      const restarted = createProjectWorkspaceStore({
        projectsDir,
        projectRegistry: restartedRegistry,
        projectRoot: tmpDir,
      });
      expect(restarted.getDataSource(PROJECT_ID, ds.id)).toEqual(ds);
    });
  });

  describe('buildProjectDataSourcesContext', () => {
    it('returns formatted markdown with all data sources', async () => {
      // Create a fresh project for this test
      const db = getDb();
      const now = Date.now();
      db.prepare(
        'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('proj-ctx', 'Context Test', '', '[]', now, now);

      await workspaceStore.createDataSource('proj-ctx', {
        uri: 'https://drive.google.com/file/abc',
        label: 'Design Doc',
        description: 'Architecture design',
        sourceType: 'gdrive',
      });
      await workspaceStore.createDataSource('proj-ctx', {
        uri: '/data/logs.csv',
        label: 'Log Data',
        sourceType: 'file',
      });

      const ctx = workspaceStore.buildDataSourcesContext('proj-ctx');
      expect(ctx).toContain('**Design Doc**');
      expect(ctx).toContain('(gdrive)');
      expect(ctx).toContain('Architecture design');
      expect(ctx).toContain('**Log Data**');
      expect(ctx).toContain('(file)');
    });

    it('returns undefined when no data sources', () => {
      expect(workspaceStore.buildDataSourcesContext('proj-empty')).toBeUndefined();
    });
  });

  describe('Rejection Tracking (SQLite)', () => {
    it('records rejection and checks isContentRejected', () => {
      const hash = 'abc123hash';
      expect(isContentRejected(PROJECT_ID, hash)).toBe(false);

      recordKnowledgeRejection({
        projectId: PROJECT_ID,
        sessionId: 'session-1',
        contentHash: hash,
        reason: 'Not relevant',
      });

      expect(isContentRejected(PROJECT_ID, hash)).toBe(true);
    });

    it('scopes rejections to project', () => {
      const hash = 'proj-scoped-hash';
      recordKnowledgeRejection({
        projectId: PROJECT_ID,
        sessionId: 'session-1',
        contentHash: hash,
      });

      expect(isContentRejected(PROJECT_ID, hash)).toBe(true);
      expect(isContentRejected('other-project', hash)).toBe(false);
    });
  });

  describe('Knowledge Linking (mocked Neo4j)', () => {
    it('linkBubbleToProject calls MERGE query', async () => {
      const neo4j = createMockNeo4j();
      const link = await linkBubbleToProject({
        neo4j,
        projectId: PROJECT_ID,
        bubbleId: 'bubble-1',
        linkedBy: 'user',
      });

      expect(link.projectId).toBe(PROJECT_ID);
      expect(link.bubbleId).toBe('bubble-1');
      expect(link.linkedBy).toBe('user');
      expect(link.createdAt).toBeDefined();
      expect(neo4j.run).toHaveBeenCalledWith(
        expect.stringContaining('MERGE'),
        expect.objectContaining({ bubbleId: 'bubble-1', projectId: PROJECT_ID }),
      );
    });

    it('unlinkBubbleFromProject calls DELETE query', async () => {
      const neo4j = createMockNeo4j();
      await unlinkBubbleFromProject(neo4j, PROJECT_ID, 'bubble-1');

      expect(neo4j.run).toHaveBeenCalledWith(
        expect.stringContaining('DELETE r'),
        expect.objectContaining({ bubbleId: 'bubble-1', projectId: PROJECT_ID }),
      );
    });

    it('getProjectKnowledgeLinks queries graph', async () => {
      const neo4j = createMockNeo4j();
      (neo4j.query as any).mockResolvedValue([
        {
          bubbleId: 'b1',
          title: 'Test',
          contentPreview: 'Preview',
          tags: ['a'],
          source: 'test',
          linkedBy: null,
          createdAt: '2026-01-01',
        },
      ]);

      const links = await getProjectKnowledgeLinks(neo4j, PROJECT_ID);
      expect(links).toHaveLength(1);
      expect(links[0].bubbleId).toBe('b1');
      expect(neo4j.query).toHaveBeenCalledWith(
        expect.stringContaining('BELONGS_TO_PROJECT'),
        expect.objectContaining({ projectId: PROJECT_ID }),
      );
    });

    it('getProjectsForBubble returns project IDs', async () => {
      const neo4j = createMockNeo4j();
      (neo4j.query as any).mockResolvedValue([{ projectId: 'p1' }, { projectId: 'p2' }]);

      const ids = await getProjectsForBubble(neo4j, 'bubble-1');
      expect(ids).toEqual(['p1', 'p2']);
    });
  });

  describe('syncProjectNodes', () => {
    it('issues MERGE query for each project', async () => {
      const neo4j = createMockNeo4j();
      await syncProjectNodes(neo4j);

      // We have at least 2 projects in the DB (proj-test-1, proj-test-2, proj-ctx)
      expect(neo4j.run).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (p:Project {id: $id})'),
        expect.objectContaining({ id: PROJECT_ID }),
      );
    });
  });

  describe('Context Injection', () => {
    it('buildSystemPrompt describes only available knowledge retrieval for project sessions', () => {
      const task: AgentTask = {
        id: 'test-task',
        skillName: SKILL_ORCHESTRATOR,
        prompt: 'test',
        status: 'running',
        priority: 'normal',
        mcpServers: {},
        agentDefinitions: {},
        projectId: PROJECT_ID,
        createdAt: Date.now(),
      };

      const prompt = buildSystemPrompt(task, undefined, { knowledgeTools: ['search_knowledge'] });
      expect(prompt).toContain('## Knowledge Tools');
      expect(prompt).toContain('search_knowledge');
      expect(prompt).not.toContain('save_knowledge');
    });

    it('does not include knowledge discovery for non-project tasks', () => {
      const task: AgentTask = {
        id: 'test-task',
        skillName: 'email',
        prompt: 'test',
        status: 'running',
        priority: 'normal',
        mcpServers: {},
        agentDefinitions: {},
        createdAt: Date.now(),
      };

      const prompt = buildSystemPrompt(task);
      expect(prompt).not.toContain('## Knowledge Discovery');
    });
  });
});
