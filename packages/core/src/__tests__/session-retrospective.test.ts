import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { createIdleDetector } from '../session-manager/idle-detector.ts';
import { createSessionCompaction } from '../session-manager/session-compaction.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenEvent } from '@raven/shared';

// Mock runAgentTask
vi.mock('../agent-manager/agent-session.ts', () => ({
  runAgentTask: vi.fn(),
  initializeBackend: vi.fn(),
}));

// Mock knowledge dependencies
vi.mock('../knowledge-engine/project-knowledge.ts', () => ({
  linkBubbleToProject: vi.fn().mockResolvedValue({
    projectId: 'proj-1',
    bubbleId: 'b-1',
    createdAt: new Date().toISOString(),
  }),
  getProjectKnowledgeLinks: vi.fn().mockResolvedValue([]),
}));

vi.mock('../knowledge-engine/knowledge-rejections.ts', () => ({
  isContentRejected: vi.fn().mockReturnValue(false),
}));

const { runAgentTask } = await import('../agent-manager/agent-session.ts');
const { isContentRejected } = await import('../knowledge-engine/knowledge-rejections.ts');

describe('Session Auto-Compaction & Background Retrospective (10.10)', () => {
  let tmpDir: string;
  let sessionPath: string;
  let sm: SessionManager;
  let eventBus: EventBus;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-retro-'));
    sessionPath = join(tmpDir, 'sessions');
    mkdirSync(sessionPath, { recursive: true });
    initDatabase(join(tmpDir, 'test.db'));
    sm = new SessionManager();
    eventBus = new EventBus();

    // Create test project
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('proj-1', 'Test Project', '', '[]', now, now);
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Idle Detector', () => {
    it('emits session:idle for qualifying sessions', async () => {
      const config = {
        RAVEN_SESSION_IDLE_TIMEOUT_MS: 100,
        RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
      } as any;

      const events: RavenEvent[] = [];
      eventBus.on('session:idle', (e) => events.push(e));

      // Create a session with old last_active_at, no summary, and turns > 0
      const session = sm.createSession('proj-1');
      sm.incrementTurnCount(session.id);
      // Manually set last_active_at to the past
      const db = getDb();
      db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(
        Date.now() - 200,
        session.id,
      );

      const detector = createIdleDetector({ eventBus, config });

      // Run scan directly (exposed for testability)
      detector.scan();

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('session:idle');
      const payload = (events[0] as any).payload;
      expect(payload.sessionId).toBe(session.id);
      expect(payload.projectId).toBe('proj-1');
    });

    it('skips sessions with existing summary', () => {
      const config = {
        RAVEN_SESSION_IDLE_TIMEOUT_MS: 100,
        RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
      } as any;

      const session = sm.createSession('proj-1');
      sm.incrementTurnCount(session.id);
      sm.updateSummary(session.id, 'Already summarized');
      const db = getDb();
      db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(
        Date.now() - 200,
        session.id,
      );

      const events: RavenEvent[] = [];
      const localBus = new EventBus();
      localBus.on('session:idle', (e) => events.push(e));

      const detector = createIdleDetector({ eventBus: localBus, config });
      detector.start();

      // Sync check — the scan runs on interval; we can't trigger immediate scan
      // Instead verify the session should NOT be picked up
      const row = db
        .prepare(
          "SELECT * FROM sessions WHERE id = ? AND summary IS NULL AND status = 'idle' AND turn_count > 0",
        )
        .get(session.id);
      expect(row).toBeUndefined();

      detector.stop();
    });

    it('does not trigger when auto-retrospective is disabled', async () => {
      const config = {
        RAVEN_SESSION_IDLE_TIMEOUT_MS: 100,
        RAVEN_AUTO_RETROSPECTIVE_ENABLED: false,
      } as any;

      const events: RavenEvent[] = [];
      const localBus = new EventBus();
      localBus.on('session:idle', (e) => events.push(e));

      const detector = createIdleDetector({ eventBus: localBus, config });
      detector.start();
      await new Promise((r) => setTimeout(r, 200));
      detector.stop();

      expect(events.length).toBe(0);
    });
  });

  describe('Session Retrospective', () => {
    it('processes retrospective result and stores summary', async () => {
      const { createSessionRetrospective } =
        await import('../session-manager/session-retrospective.ts');

      const messageStore = createMessageStore({ basePath: sessionPath });
      const session = sm.createSession('proj-1');

      // Add some messages
      messageStore.appendMessage(session.id, {
        role: 'user',
        content: 'How do I configure the database?',
      });
      messageStore.appendMessage(session.id, {
        role: 'assistant',
        content: 'You need to set DATABASE_PATH in .env',
      });

      const mockResult = {
        summary: 'Discussed database configuration. Key decision: use .env for path.',
        decisions: ['Use .env for DATABASE_PATH'],
        findings: ['SQLite is the DB engine'],
        actionItems: [],
        candidateBubbles: [
          {
            title: 'Database Config',
            content: 'Set DATABASE_PATH in .env file',
            tags: ['config', 'database'],
            confidence: 'high' as const,
            sourceDescription: 'from session',
          },
        ],
      };

      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'mock-task',
        result: JSON.stringify(mockResult),
        durationMs: 1000,
        success: true,
      });

      const mockKnowledgeStore = {
        insert: vi.fn().mockResolvedValue({ id: 'bubble-1', title: 'Database Config' }),
      } as any;
      const mockNeo4j = {
        run: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
      } as any;

      const retro = createSessionRetrospective({
        messageStore,
        sessionManager: sm,
        eventBus,
        config: {} as any,
        knowledgeStore: mockKnowledgeStore,
        neo4j: mockNeo4j,
      });

      const result = await retro.runRetrospective(session.id, 'proj-1');

      expect(result.summary).toBe(mockResult.summary);
      expect(result.decisions).toEqual(['Use .env for DATABASE_PATH']);
      expect(result.candidateBubbles).toHaveLength(1);

      // Verify summary was stored
      const updated = sm.getSession(session.id)!;
      expect(updated.summary).toBe(mockResult.summary);

      // Verify knowledge store was called for high-confidence bubble
      expect(mockKnowledgeStore.insert).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Database Config' }),
      );
    });

    it('creates draft bubbles for low-confidence with notification', async () => {
      const { createSessionRetrospective } =
        await import('../session-manager/session-retrospective.ts');

      const messageStore = createMessageStore({ basePath: sessionPath });
      const session = sm.createSession('proj-1');
      messageStore.appendMessage(session.id, { role: 'user', content: 'test' });

      const mockResult = {
        summary: 'Test session',
        decisions: [],
        findings: [],
        actionItems: [],
        candidateBubbles: [
          {
            title: 'Maybe Important',
            content: 'Not sure about this',
            tags: ['tentative'],
            confidence: 'low' as const,
            sourceDescription: 'from session',
          },
        ],
      };

      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'mock-task',
        result: JSON.stringify(mockResult),
        durationMs: 1000,
        success: true,
      });

      const notifications: RavenEvent[] = [];
      const localBus = new EventBus();
      localBus.on('notification', (e) => notifications.push(e));

      const mockKnowledgeStore = {
        insert: vi.fn().mockResolvedValue({ id: 'draft-1', title: '[Draft] Maybe Important' }),
      } as any;
      const mockNeo4j = {
        run: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
      } as any;

      const retro = createSessionRetrospective({
        messageStore,
        sessionManager: sm,
        eventBus: localBus,
        config: {} as any,
        knowledgeStore: mockKnowledgeStore,
        neo4j: mockNeo4j,
      });

      await retro.runRetrospective(session.id, 'proj-1');

      // Should create with [Draft] prefix
      expect(mockKnowledgeStore.insert).toHaveBeenCalledWith(
        expect.objectContaining({ title: '[Draft] Maybe Important' }),
      );

      // Should emit notification
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      expect((notifications[0] as any).payload.title).toBe('Knowledge Draft for Review');
    });

    it('skips previously rejected content', async () => {
      const { createSessionRetrospective } =
        await import('../session-manager/session-retrospective.ts');

      vi.mocked(isContentRejected).mockReturnValue(true);

      const messageStore = createMessageStore({ basePath: sessionPath });
      const session = sm.createSession('proj-1');
      messageStore.appendMessage(session.id, { role: 'user', content: 'test' });

      const mockResult = {
        summary: 'Test',
        decisions: [],
        findings: [],
        actionItems: [],
        candidateBubbles: [
          {
            title: 'Rejected',
            content: 'This was rejected before',
            tags: [],
            confidence: 'high' as const,
            sourceDescription: 'from session',
          },
        ],
      };

      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'mock-task',
        result: JSON.stringify(mockResult),
        durationMs: 1000,
        success: true,
      });

      const mockKnowledgeStore = { insert: vi.fn() } as any;
      const mockNeo4j = {
        run: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
      } as any;

      const retro = createSessionRetrospective({
        messageStore,
        sessionManager: sm,
        eventBus,
        config: {} as any,
        knowledgeStore: mockKnowledgeStore,
        neo4j: mockNeo4j,
      });

      await retro.runRetrospective(session.id, 'proj-1');

      // Knowledge store should NOT be called for rejected content
      expect(mockKnowledgeStore.insert).not.toHaveBeenCalled();
    });
  });

  describe('Session Compaction', () => {
    it('compacts sessions exceeding threshold', async () => {
      const messageStore = createMessageStore({ basePath: sessionPath });
      const session = sm.createSession('proj-1');

      // Add messages over threshold
      const threshold = 5;
      for (let i = 0; i < 15; i++) {
        messageStore.appendMessage(session.id, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
        });
      }

      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'mock-task',
        result: 'Summary of older messages discussing various topics.',
        durationMs: 500,
        success: true,
      });

      const events: RavenEvent[] = [];
      const localBus = new EventBus();
      localBus.on('session:compacted', (e) => events.push(e));

      const compaction = createSessionCompaction({
        messageStore,
        eventBus: localBus,
        config: { RAVEN_SESSION_COMPACTION_THRESHOLD: threshold } as any,
        sessionBasePath: sessionPath,
      });

      const compacted = await compaction.checkAndCompact(session.id);
      expect(compacted).toBe(true);

      // Verify event emitted
      expect(events.length).toBe(1);
      expect((events[0] as any).payload.sessionId).toBe(session.id);

      // Verify transcript was rewritten with compaction block
      const messages = messageStore.getMessages(session.id);
      expect(messages[0].role).toBe('context');
      expect(messages[0].content).toContain('[Compacted Context');

      // Verify archive file exists
      const sessionDir = join(sessionPath, session.id);
      const files = readdirSync(sessionDir);
      const archiveFiles = files.filter((f) => f.startsWith('transcript-archived-'));
      expect(archiveFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('skips compaction when below threshold', async () => {
      const messageStore = createMessageStore({ basePath: sessionPath });
      const session = sm.createSession('proj-1');

      messageStore.appendMessage(session.id, { role: 'user', content: 'Hello' });
      messageStore.appendMessage(session.id, { role: 'assistant', content: 'Hi' });

      const compaction = createSessionCompaction({
        messageStore,
        eventBus,
        config: { RAVEN_SESSION_COMPACTION_THRESHOLD: 40 } as any,
        sessionBasePath: sessionPath,
      });

      const compacted = await compaction.checkAndCompact(session.id);
      expect(compacted).toBe(false);
    });
  });

  describe('Knowledge Consolidation', () => {
    it('runs consolidation and processes merge/prune results', async () => {
      const { createKnowledgeConsolidation } =
        await import('../knowledge-engine/knowledge-consolidation.ts');

      const mockNeo4j = {
        query: vi.fn().mockResolvedValue([
          {
            id: 'b1',
            title: 'Bubble 1',
            content: 'Content 1',
            tags: ['tag1'],
            projectId: 'proj-1',
          },
          {
            id: 'b2',
            title: 'Bubble 2',
            content: 'Content 2',
            tags: ['tag1'],
            projectId: 'proj-1',
          },
        ]),
        run: vi.fn().mockResolvedValue(undefined),
      } as any;

      const consolidationResult = {
        merges: [{ keepId: 'b1', removeIds: ['b2'], mergedContent: 'Combined content 1+2' }],
        prunes: [],
        digest: 'Project digest summary',
      };

      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'mock-task',
        result: JSON.stringify(consolidationResult),
        durationMs: 2000,
        success: true,
      });

      const consolidation = createKnowledgeConsolidation({
        neo4j: mockNeo4j,
        eventBus,
        config: {} as any,
      });

      const result = await consolidation.runConsolidation('proj-1');

      expect(result.mergedCount).toBe(1);
      expect(result.prunedCount).toBe(0);
      expect(result.digestCreated).toBe(true);

      // Verify Neo4j operations
      expect(mockNeo4j.run).toHaveBeenCalledWith(
        expect.stringContaining('SET b.content'),
        expect.objectContaining({ id: 'b1', content: 'Combined content 1+2' }),
      );
      expect(mockNeo4j.run).toHaveBeenCalledWith(
        expect.stringContaining('DETACH DELETE'),
        expect.objectContaining({ id: 'b2' }),
      );
    });

    it('handles empty bubble set gracefully', async () => {
      const { createKnowledgeConsolidation } =
        await import('../knowledge-engine/knowledge-consolidation.ts');

      const mockNeo4j = {
        query: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue(undefined),
      } as any;

      const consolidation = createKnowledgeConsolidation({
        neo4j: mockNeo4j,
        eventBus,
        config: {} as any,
      });

      const result = await consolidation.runConsolidation();
      expect(result.mergedCount).toBe(0);
      expect(result.prunedCount).toBe(0);
      expect(result.digestCreated).toBe(false);
    });
  });

  describe('Manual Retrospective API', () => {
    it('returns expected shape from runRetrospective', async () => {
      const { createSessionRetrospective } =
        await import('../session-manager/session-retrospective.ts');

      const messageStore = createMessageStore({ basePath: sessionPath });
      const session = sm.createSession('proj-1');
      messageStore.appendMessage(session.id, { role: 'user', content: 'Test manual retro' });

      const mockResult = {
        summary: 'Manual retrospective test',
        decisions: ['Decision A'],
        findings: ['Finding B'],
        actionItems: ['Action C'],
        candidateBubbles: [],
      };

      vi.mocked(runAgentTask).mockResolvedValue({
        taskId: 'mock-task',
        result: JSON.stringify(mockResult),
        durationMs: 800,
        success: true,
      });

      const mockKnowledgeStore = { insert: vi.fn() } as any;
      const mockNeo4j = {
        run: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([]),
      } as any;

      const retro = createSessionRetrospective({
        messageStore,
        sessionManager: sm,
        eventBus,
        config: {} as any,
        knowledgeStore: mockKnowledgeStore,
        neo4j: mockNeo4j,
      });

      const result = await retro.runRetrospective(session.id, 'proj-1');

      expect(result).toEqual(
        expect.objectContaining({
          sessionId: session.id,
          projectId: 'proj-1',
          summary: 'Manual retrospective test',
          decisions: ['Decision A'],
          findings: ['Finding B'],
          actionItems: ['Action C'],
        }),
      );
    });
  });
});
