import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SkillRegistry } from '../skill-registry/skill-registry.ts';
import { McpManager } from '../mcp-manager/mcp-manager.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RavenEvent, RavenSkill } from '@raven/shared';

function makeSkill(
  name: string,
  mcpServers: Record<string, { command: string; args: string[] }> = {},
): RavenSkill {
  return {
    manifest: {
      name,
      displayName: name,
      version: '1.0.0',
      description: `${name} skill`,
      capabilities: ['mcp-server'],
      defaultSchedules: [
        {
          id: `${name}-sched`,
          name: `${name} schedule`,
          cron: '0 8 * * *',
          taskType: `${name}-task`,
          enabled: true,
        },
      ],
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getMcpServers: () => mcpServers,
    getAgentDefinitions: () => ({
      [`${name}-agent`]: { description: `${name} agent`, prompt: `Do ${name} things` },
    }),
    handleScheduledTask: vi.fn().mockResolvedValue({
      taskId: 'scheduled-task-1',
      prompt: `Execute ${name} scheduled task`,
      skillName: name,
      mcpServers,
      priority: 'normal' as const,
    }),
  };
}

describe('Orchestrator', () => {
  let tmpDir: string;
  let eventBus: EventBus;
  let skillRegistry: SkillRegistry;
  let mcpManager: McpManager;
  let _orchestrator: Orchestrator;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-orch-'));
    initDatabase(join(tmpDir, 'test.db'));
    eventBus = new EventBus();
    skillRegistry = new SkillRegistry();
    mcpManager = new McpManager(skillRegistry);
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
    _orchestrator = new Orchestrator(eventBus, skillRegistry, mcpManager);

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
    expect(payload.prompt).toBe('Hello Raven');
    expect(payload.priority).toBe('high');
  });

  it('email:new emits agent:task:request with gmail MCPs', async () => {
    const gmailSkill = makeSkill('gmail', {
      gmail_api: { command: 'node', args: ['gmail-mcp.js'] },
    });
    await skillRegistry.registerSkill(
      gmailSkill,
      {},
      {
        eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
        db: { run: vi.fn(), get: vi.fn(), all: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        getSkillData: vi.fn().mockResolvedValue(null),
      },
    );

    _orchestrator = new Orchestrator(eventBus, skillRegistry, mcpManager);

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
    expect(payload.skillName).toBe('gmail');
    expect(payload.mcpServers).toHaveProperty('gmail_api');
  });

  it('schedule:triggered delegates to skill handleScheduledTask', async () => {
    const digestSkill = makeSkill('digest');
    await skillRegistry.registerSkill(
      digestSkill,
      {},
      {
        eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
        db: { run: vi.fn(), get: vi.fn(), all: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        getSkillData: vi.fn().mockResolvedValue(null),
      },
    );

    _orchestrator = new Orchestrator(eventBus, skillRegistry, mcpManager);

    const taskRequestPromise = new Promise<RavenEvent>((resolve) => {
      eventBus.on('agent:task:request', (e) => resolve(e));
    });

    eventBus.emit({
      id: 'evt-3',
      timestamp: Date.now(),
      source: 'scheduler',
      type: 'schedule:triggered',
      payload: {
        scheduleId: 'digest-sched',
        scheduleName: 'digest schedule',
        taskType: 'digest-task',
      },
    } as RavenEvent);

    // Wait for async handler
    await taskRequestPromise;
    expect(digestSkill.handleScheduledTask).toHaveBeenCalledWith(
      'digest-task',
      expect.objectContaining({
        db: expect.objectContaining({
          run: expect.any(Function),
          get: expect.any(Function),
          all: expect.any(Function),
        }),
      }),
    );
  });

  it('schedule:triggered with unknown taskType logs warning and does not emit', async () => {
    _orchestrator = new Orchestrator(eventBus, skillRegistry, mcpManager);

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
