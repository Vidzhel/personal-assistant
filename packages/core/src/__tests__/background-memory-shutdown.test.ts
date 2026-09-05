import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NamedAgent, RavenEvent } from '@raven/shared';
import { setConfig } from '../config.ts';
import { initDatabase, closeDatabase } from '../db/database.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { setActiveBackend } from '../agent-manager/agent-session.ts';
import type { BackendOptions, BackendResult } from '../agent-manager/agent-backend.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import { createMemoryStore } from '../agent-memory/memory-store.ts';
import { writeMemoryCandidate } from '../agent-memory/memory-candidates.ts';
import {
  createMemoryConsolidation,
  type MemoryConsolidation,
} from '../agent-memory/memory-consolidation.ts';
import { createHeartbeat, type Heartbeat } from '../services/system/heartbeat.ts';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';
import { buildTestConfig } from './fixtures/raven-fixture.ts';

function namedAgents(): NamedAgentStore {
  const agent: NamedAgent = {
    id: 'raven',
    name: 'raven',
    skills: [],
    model: null,
    maxTurns: null,
    description: null,
    instructions: null,
    isDefault: true,
    createdAt: '',
    updatedAt: '',
  };
  return {
    listAgents: () => [agent],
    getDefaultAgent: () => agent,
    getAgent: () => agent,
    getAgentByName: () => agent,
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
  };
}

describe('direct background model callers stop before their stores are disposed', () => {
  let root: string;
  let projectsDir: string;
  let eventBus: EventBus;
  let events: RavenEvent[];
  let heartbeat: Heartbeat | undefined;
  let consolidation: MemoryConsolidation | undefined;
  const config = { ...buildTestConfig(), RAVEN_HEARTBEAT_ACTIVE_HOURS: '00-24' };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'raven-background-stop-'));
    projectsDir = join(root, 'projects');
    setConfig(config);
    eventBus = new EventBus();
    events = [];
    eventBus.on('notification', (event) => events.push(event));
    eventBus.on('agent:message', (event) => events.push(event));
  });

  afterEach(async () => {
    await heartbeat?.stop();
    await consolidation?.stop();
    heartbeat = undefined;
    consolidation = undefined;
    closeDatabase();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function holdBackend() {
    let options: BackendOptions | undefined;
    let resolve!: (value: BackendResult) => void;
    const backend = vi.fn((input: BackendOptions) => {
      options = input;
      return new Promise<BackendResult>((done) => {
        resolve = done;
      });
    });
    setActiveBackend(backend);
    return { backend, options: () => options!, resolve: (value: BackendResult) => resolve(value) };
  }

  function makeConsolidation(memoryStore = createMemoryStore({ projectsDir })) {
    consolidation = createMemoryConsolidation({
      projectsDir,
      memoryStore,
      namedAgentStore: namedAgents(),
      eventBus,
      config,
    });
    return consolidation;
  }

  it('aborts a held heartbeat and ignores late callbacks after SQLite is closed', async () => {
    const held = holdBackend();
    heartbeat = createHeartbeat({
      db: initDatabase(join(root, 'test.db')),
      executionLogger: {
        queryTasks: vi.fn(() => []),
      } as unknown as ExecutionLogger,
      eventBus,
      sessionManager: new SessionManager(),
      config,
    });
    const outcome = heartbeat.fireHeartbeat().catch((error: unknown) => error);
    await vi.waitFor(() => expect(held.backend).toHaveBeenCalledTimes(1));
    held.options().onSessionId?.('known-before-stop');
    await heartbeat.stop();
    expect(held.options().signal?.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(DOMException);
    expect(heartbeat.isRunning()).toBe(false);
    closeDatabase();
    held.options().onAssistantMessage('A late alert');
    held.options().onSessionId?.('late-session');
    held.resolve({ result: 'A late alert', success: true, errors: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
    await expect(heartbeat.fireHeartbeat()).rejects.toMatchObject({ name: 'AbortError' });
    expect(held.backend).toHaveBeenCalledTimes(1);
  });

  it('keeps candidates pending when a held consolidation is stopped before model completion', async () => {
    const held = holdBackend();
    const candidate = await writeMemoryCandidate({ projectsDir }, 'raven', {
      title: 'Preference',
      content: 'Keep concise responses.',
      source: 'session-retrospective',
    });
    const pendingDir = join(projectsDir, 'agents/raven/memory/candidates');
    const candidateBefore = readFileSync(join(pendingDir, candidate!), 'utf8');
    const operation = makeConsolidation()
      .runConsolidation()
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(held.backend).toHaveBeenCalledTimes(1));
    await consolidation!.stop();
    expect(held.options().signal?.aborted).toBe(true);
    expect(await operation).toBeInstanceOf(DOMException);
    held.options().onAssistantMessage('Late model output');
    held.resolve({
      result: JSON.stringify({
        ops: [{ action: 'create', path: 'late.md', content: 'Late memory' }],
      }),
      success: true,
      errors: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(readdirSync(join(projectsDir, 'agents/raven/memory'))).toEqual(['candidates']);
    expect(readFileSync(join(pendingDir, candidate!), 'utf8')).toBe(candidateBefore);
    expect(events).toEqual([]);
    await expect(consolidation!.runConsolidation()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('drains an admitted memory write before stop resolves and starts no next mutation', async () => {
    setActiveBackend(async () => ({
      result: JSON.stringify({
        ops: [
          { action: 'create', path: 'first.md', content: 'Already admitted write' },
          { action: 'create', path: 'second.md', content: 'Must not start' },
        ],
      }),
      success: true,
      errors: [],
    }));
    await writeMemoryCandidate({ projectsDir }, 'raven', {
      title: 'Preference',
      content: 'Keep concise responses.',
      source: 'session-retrospective',
    });
    const memoryStore = createMemoryStore({ projectsDir });
    const actualWrite = memoryStore.write.bind(memoryStore);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.spyOn(memoryStore, 'write').mockImplementationOnce(async (...args) => {
      await hold;
      return actualWrite(...args);
    });
    const operation = makeConsolidation(memoryStore)
      .runConsolidation()
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = consolidation!.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await operation).toBeInstanceOf(DOMException);
    expect(write).toHaveBeenCalledTimes(1);
    const memoryDir = join(projectsDir, 'agents/raven/memory');
    expect(readFileSync(join(memoryDir, 'first.md'), 'utf8')).toContain('Already admitted write');
    expect(existsSync(join(memoryDir, 'second.md'))).toBe(false);
    expect(existsSync(join(memoryDir, 'MEMORY.md'))).toBe(false);
    expect(existsSync(join(memoryDir, 'candidates/archive'))).toBe(false);
  });
});
