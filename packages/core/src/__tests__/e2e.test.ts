import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';

// Mock the claude-code SDK to avoid real subprocess calls
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn(async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'mock-session-1' };
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello from mock agent!' }] },
    };
    yield { type: 'result', subtype: 'success', result: 'Mock agent completed successfully.' };
  }),
}));

// Mock config
vi.mock('../config.ts', () => {
  let config: Record<string, unknown> | null = null;
  return {
    loadConfig: () => {
      config = {
        ANTHROPIC_API_KEY: 'test-key',
        CLAUDE_MODEL: 'claude-sonnet-4-5-20250514',
        RAVEN_PORT: 0, // Will be overridden
        RAVEN_TIMEZONE: 'UTC',
        RAVEN_DIGEST_TIME: '08:00',
        RAVEN_MAX_CONCURRENT_AGENTS: 3,
        RAVEN_AGENT_MAX_TURNS: 25,
        RAVEN_MAX_BUDGET_USD_PER_DAY: 5.0,
        DATABASE_PATH: '', // Will be set in test
        SESSION_PATH: '',
        LOG_LEVEL: 'info',
      };
      return config;
    },
    getConfig: () => {
      if (!config) throw new Error('Config not loaded');
      return config;
    },
    loadSkillsConfig: () => ({}),
    loadSchedulesConfig: () => [],
  };
});

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../event-bus/event-bus.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { SkillRegistry } from '../skill-registry/skill-registry.ts';
import { McpManager } from '../mcp-manager/mcp-manager.ts';
import { AgentManager } from '../agent-manager/agent-manager.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import { createApiServer } from '../api/server.ts';
import { loadConfig } from '../config.ts';
import type { RavenEvent } from '@raven/shared';

describe('E2E: Full boot → chat → events flow', () => {
  let tmpDir: string;
  let eventBus: EventBus;
  let server: Awaited<ReturnType<typeof createApiServer>>;
  let port: number;
  let scheduler: Scheduler;
  let agentManager: AgentManager;
  let executionLogger: ReturnType<typeof createExecutionLogger>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-'));
    const dbPath = join(tmpDir, 'test.db');
    const sessionPath = join(tmpDir, 'sessions');
    mkdirSync(sessionPath, { recursive: true });

    // Load config (uses mocked version)
    const config = loadConfig();
    (config as Record<string, unknown>).DATABASE_PATH = dbPath;
    (config as Record<string, unknown>).SESSION_PATH = sessionPath;

    // Init database
    initDatabase(dbPath);

    // Init all components
    eventBus = new EventBus();
    const skillRegistry = new SkillRegistry();
    const mcpManager = new McpManager(skillRegistry);
    const sessionManager = new SessionManager();
    const _orchestrator = new Orchestrator(eventBus, skillRegistry, mcpManager);
    scheduler = new Scheduler(eventBus, 'UTC');
    await scheduler.initialize([]);

    // Start API server on random port
    const auditLog = createAuditLog(getDb());
    auditLog.initialize();
    const pendingApprovals = createPendingApprovals(getDb());
    pendingApprovals.initialize();
    executionLogger = createExecutionLogger({ db: getDb() });
    agentManager = new AgentManager({ eventBus, mcpManager, skillRegistry, executionLogger });

    server = await createApiServer(
      {
        eventBus,
        skillRegistry,
        sessionManager,
        scheduler,
        agentManager,
        auditLog,
        pendingApprovals,
        executionLogger,
        configuredSkillCount: 0,
      },
      0, // Let OS assign port
    );

    const address = server.addresses()[0];
    port = address.port;
  });

  afterAll(async () => {
    scheduler.shutdown();
    await server.close();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('health check works', async () => {
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    // Status is 'ok' when configuredSkillCount=0 and no skills loaded (no failures to detect)
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('subsystems');
    expect(body).toHaveProperty('taskStats');
    expect(body).toHaveProperty('memory');
  });

  it('full chat flow: create project → send chat → receive events', async () => {
    // 1. Create a project
    const createRes = await fetch(`http://localhost:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Test Project' }),
    });
    expect(createRes.ok).toBe(true);
    const project = (await createRes.json()) as Record<string, unknown>;
    expect(project.id).toBeDefined();

    // 2. Listen for events
    const receivedEvents: RavenEvent[] = [];
    const chatMessageReceived = new Promise<void>((resolve) => {
      eventBus.on('user:chat:message', (e) => {
        receivedEvents.push(e);
        resolve();
      });
    });

    const taskCompleted = new Promise<void>((resolve) => {
      eventBus.on('agent:task:complete', (e) => {
        receivedEvents.push(e);
        resolve();
      });
    });

    // 3. Send a chat message via HTTP
    const chatRes = await fetch(
      `http://localhost:${port}/api/projects/${project.id as string}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello Raven, what can you do?' }),
      },
    );
    expect(chatRes.ok).toBe(true);
    expect(await chatRes.json()).toEqual({ status: 'queued' });

    // 4. Verify event bus received user:chat:message
    await chatMessageReceived;
    const chatEvent = receivedEvents.find((e) => e.type === 'user:chat:message');
    expect(chatEvent).toBeDefined();

    // 5. Wait for agent task to complete (mocked SDK)
    await taskCompleted;
    const completeEvent = receivedEvents.find((e) => e.type === 'agent:task:complete');
    expect(completeEvent).toBeDefined();
    expect((completeEvent as any).payload.success).toBe(true);
    expect((completeEvent as any).payload.result).toBe('Mock agent completed successfully.');

    // 6. Verify the project exists in database
    const projectRes = await fetch(`http://localhost:${port}/api/projects/${project.id as string}`);
    expect(projectRes.ok).toBe(true);
    const fetchedProject = (await projectRes.json()) as Record<string, unknown>;
    expect(fetchedProject.name).toBe('E2E Test Project');
  });

  it('execution logger persists task records to DB', async () => {
    const tasks = executionLogger.queryTasks({});
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const task = tasks[0];
    expect(task.status).toBe('completed');
    expect(task.skillName).toBeDefined();
    expect(task.durationMs).toBeDefined();
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('project listing works after creation', async () => {
    const res = await fetch(`http://localhost:${port}/api/projects`);
    expect(res.ok).toBe(true);
    const projects = (await res.json()) as unknown[];
    expect(projects.length).toBeGreaterThanOrEqual(1);
  });

  it('schedules endpoint works', async () => {
    const res = await fetch(`http://localhost:${port}/api/schedules`);
    expect(res.ok).toBe(true);
    const schedules = await res.json();
    expect(Array.isArray(schedules)).toBe(true);
  });

  it('skills endpoint works', async () => {
    const res = await fetch(`http://localhost:${port}/api/skills`);
    expect(res.ok).toBe(true);
    const skills = await res.json();
    expect(Array.isArray(skills)).toBe(true);
  });
});
