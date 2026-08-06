import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    // The user prompt carries only the message itself now — stable
    // instructions (system access, tool use, MCP tools) are rendered into
    // the system prompt by prompt-builder.ts instead (see prompt-builder.test.ts).
    expect(payload.prompt).toBe('Hello Raven');
    expect(payload.systemAccessInstructions).toContain('MUST NOT read or modify'); // default 'none' for regular projects
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

  it('meta-project chat resolves read-write system access', async () => {
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

    // System access should be read-write for meta-project — rendered into
    // the system prompt by prompt-builder.ts (see prompt-builder.test.ts for
    // the MCP tool / tool-use instruction assertions, which are now
    // constant and don't depend on the project).
    expect(payload.systemAccessInstructions).toContain('may read and modify system files');
    // The user prompt carries only the original message.
    expect(payload.prompt).toBe('Show me all projects');
  });
});
