import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { createMessageStore } from '../session-manager/message-store.ts';
import { initDatabase, getDb } from '../db/database.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RavenEvent, McpServerConfig } from '@raven/shared';

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeMockCapabilityLibrary(mcpServers: Record<string, McpServerConfig> = {}): any {
  return {
    collectMcpServers: (): Record<string, McpServerConfig> => mcpServers,
    collectAgentDefinitions: (): Record<string, unknown> => ({}),
    resolveVendorPlugins: (): unknown[] => [],
  };
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
    _orchestrator = new Orchestrator({
      eventBus,
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

  it('email:new emits agent:task:request with the gmail library skill MCPs', async () => {
    const capabilityLibrary = makeMockCapabilityLibrary({
      gmail: { command: 'node', args: ['gmail-mcp.js'] },
    });

    _orchestrator = new Orchestrator({
      eventBus,
      capabilityLibrary,
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
    expect(payload.skillName).toBe('gmail');
    expect(payload.mcpServers).toHaveProperty('gmail');
  });

  it('meta-project chat resolves read-write system access', async () => {
    _orchestrator = new Orchestrator({
      eventBus,
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

  it('ensureProject collision: two auto-created projects kebab to the same slug without losing either message', async () => {
    const projectsDir = join(tmpDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    const projectRegistry = new ProjectRegistry();
    await projectRegistry.load(projectsDir);
    const agentYamlStore = createAgentYamlStore();
    const scaffoldingApi = createScaffoldingApi({ projectsDir, projectRegistry, agentYamlStore });

    const sessionManager = new SessionManager();
    const messageStore = createMessageStore({ basePath: join(tmpDir, 'sessions') });

    _orchestrator = new Orchestrator({
      eventBus,
      sessionManager,
      messageStore,
      projectRegistry,
      scaffoldingApi,
      projectsDir,
      port: 4000,
    });

    const taskRequests: RavenEvent[] = [];
    eventBus.on('agent:task:request', (e) => taskRequests.push(e));

    // Neither event carries a topicName, so both default to displayName
    // "Inbox" and both kebab to fs_path "inbox" — simulating two unrelated
    // auto-created projects (e.g. two direct-mode chats, or two Telegram
    // topics literally named "Inbox") landing on the same slug.
    eventBus.emit({
      id: 'evt-a',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId: 'chat-a', message: 'first message' },
    } as RavenEvent);
    await waitFor(() => taskRequests.length >= 1);

    eventBus.emit({
      id: 'evt-b',
      timestamp: Date.now(),
      source: 'test',
      type: 'user:chat:message',
      payload: { projectId: 'chat-b', message: 'second message' },
    } as RavenEvent);
    await waitFor(() => taskRequests.length >= 2);

    const db = getDb();
    const rowA = db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('chat-a') as {
      fs_path: string | null;
    };
    const rowB = db.prepare('SELECT fs_path FROM projects WHERE id = ?').get('chat-b') as {
      fs_path: string | null;
    };
    // Each caller receives a separate managed definition immediately.
    expect(rowA.fs_path).toBe('inbox');
    expect(rowB.fs_path).toBe('inbox-2');
    expect(projectRegistry.getProject('inbox-2')).toBeDefined();

    // The actual bug this guards against: neither user message was lost.
    const sessionA = sessionManager.getOrCreateSession('chat-a');
    const sessionB = sessionManager.getOrCreateSession('chat-b');
    expect(messageStore.getMessages(sessionA.id).some((m) => m.content === 'first message')).toBe(
      true,
    );
    expect(messageStore.getMessages(sessionB.id).some((m) => m.content === 'second message')).toBe(
      true,
    );
  });
});
