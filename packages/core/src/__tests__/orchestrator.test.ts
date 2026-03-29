import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RavenEvent, McpServerConfig } from '@raven/shared';

function makeSuiteRegistry(
  suites: Array<{
    name: string;
    mcpServers?: Record<string, McpServerConfig>;
    agents?: Array<{ name: string; description: string; prompt: string; tools: string[] }>;
    schedules?: Array<{
      id: string;
      name: string;
      cron: string;
      taskType: string;
      enabled: boolean;
    }>;
  }> = [],
): SuiteRegistry {
  const registry = new SuiteRegistry();
  // Manually populate the internal map for testing
  for (const suite of suites) {
    (registry as any).suites.set(suite.name, {
      manifest: {
        name: suite.name,
        displayName: suite.name,
        version: '1.0.0',
        description: `${suite.name} suite`,
        capabilities: [],
        requiresEnv: [],
        services: [],
      },
      agents: (suite.agents ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        model: 'sonnet',
        tools: a.tools,
        maxTurns: 10,
        prompt: a.prompt,
      })),
      mcpServers: suite.mcpServers ?? {},
      actions: [],
      schedules: suite.schedules ?? [],
      vendorPlugins: [],
      suiteDir: '/tmp/test',
    });
  }
  return registry;
}

describe('Orchestrator', () => {
  let tmpDir: string;
  let eventBus: EventBus;
  let _orchestrator: Orchestrator;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-orch-'));
    initDatabase(join(tmpDir, 'test.db'));
    eventBus = new EventBus();
  });

  afterEach(() => {
    eventBus.removeAllListeners();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('user:chat:message emits agent:task:request with empty mcpServers', async () => {
    const suiteRegistry = makeSuiteRegistry();
    _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    // Create a project in DB
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-1', 'Test', '["gmail"]', now, now);

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId: 'proj-1', message: 'Hello Raven' },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as unknown as { payload: Record<string, unknown> }).payload;
    expect(payload.skillName).toBe('orchestrator');
    expect(payload.mcpServers).toEqual({}); // NO MCPs on orchestrator
    // System access and tool use instructions are now prepended
    expect(payload.prompt).toContain('Hello Raven');
    expect(payload.prompt).toContain('System Access Control');
    expect(payload.prompt).toContain('MUST NOT read or modify'); // default 'none' for regular projects
    expect(payload.prompt).toContain('Use tools purposefully');
    expect(payload.priority).toBe('high');
  });

  it('email:new emits agent:task:request with email MCPs', async () => {
    const suiteRegistry = makeSuiteRegistry([
      {
        name: 'email',
        mcpServers: {
          email_gmail: { command: 'node', args: ['gmail-mcp.js'] },
        },
      },
    ]);

    _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-2',
      timestamp: Date.now(),
      source: 'gmail',
      type: 'email:new',
      payload: {
        from: 'test@example.com',
        subject: 'Test Email',
        snippet: 'Hello world',
        messageId: 'msg-1',
        receivedAt: Date.now(),
      },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as unknown as { payload: Record<string, unknown> }).payload;
    expect(payload.skillName).toBe('email');
    expect(payload.mcpServers).toHaveProperty('email_gmail');
  });

  it('schedule:triggered emits agent:task:request for matching suite', async () => {
    const suiteRegistry = makeSuiteRegistry([
      {
        name: 'daily-briefing',
        schedules: [
          {
            id: 'morning-digest',
            name: 'Morning Digest',
            cron: '0 8 * * *',
            taskType: 'morning-digest',
            enabled: true,
          },
        ],
      },
    ]);

    _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-3',
      timestamp: Date.now(),
      source: 'scheduler',
      type: 'schedule:triggered',
      payload: {
        scheduleId: 'morning-digest',
        scheduleName: 'Morning Digest',
        taskType: 'morning-digest',
      },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as unknown as { payload: Record<string, unknown> }).payload;
    expect(payload.skillName).toBe('daily-briefing');
  });

  it('meta-project chat includes MCP tool instructions and read-write access', async () => {
    const suiteRegistry = makeSuiteRegistry();
    _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-meta',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId: 'meta', message: 'Show me all projects' },
    } as RavenEvent);

    const event = await taskRequestPromise;
    const payload = (event as unknown as { payload: Record<string, unknown> }).payload;
    const prompt = payload.prompt as string;

    // System access should be read-write for meta-project
    expect(prompt).toContain('may read and modify system files');
    // MCP tool instructions (replaces REST API injection)
    expect(prompt).toContain('Raven MCP tools');
    expect(prompt).toContain('classify_request');
    expect(prompt).toContain('create_task_tree');
    // Tool use instructions
    expect(prompt).toContain('Use tools purposefully');
    // Original message
    expect(prompt).toContain('Show me all projects');
  });

  it('schedule:triggered with unknown taskType logs warning and does not emit', async () => {
    const suiteRegistry = makeSuiteRegistry();

    _orchestrator = new Orchestrator({
      eventBus,
      suiteRegistry,
      sessionManager: new SessionManager(),
      messageStore: createMessageStore({ basePath: join(tmpDir, 'sessions') }),
      port: 4000,
    });

    const handler = vi.fn();
    eventBus.on('agent:task:request', handler);

    eventBus.emit({
      id: 'evt-4',
      timestamp: Date.now(),
      source: 'scheduler',
      type: 'schedule:triggered',
      payload: {
        scheduleId: 'unknown-sched',
        scheduleName: 'unknown',
        taskType: 'nonexistent-task',
      },
    } as RavenEvent);

    await new Promise((r) => setTimeout(r, 50));
    expect(handler).not.toHaveBeenCalled();
  });
});
