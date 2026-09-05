import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTaskRequestEvent, AgentTaskCompleteEvent } from '@raven/shared';
import type { BackendOptions, AgentBackend } from '../agent-manager/agent-backend.ts';
import type * as MemoryStoreModule from '../agent-memory/memory-store.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const fsGate = vi.hoisted(() => {
  let heldPath: string | undefined;
  let enteredResolve: (() => void) | undefined;
  let releaseResolve: (() => void) | undefined;
  let entered = Promise.resolve();
  let released = Promise.resolve();

  return {
    arm(path: string) {
      heldPath = path;
      entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      released = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
    },
    matches(path: unknown): boolean {
      return typeof path === 'string' && path === heldPath;
    },
    entered() {
      enteredResolve?.();
    },
    waitUntilEntered() {
      return entered;
    },
    release() {
      releaseResolve?.();
      heldPath = undefined;
    },
    waitUntilReleased() {
      return released;
    },
  };
});

vi.mock('../agent-memory/memory-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof MemoryStoreModule>();
  return {
    ...actual,
    createMemoryStore: (deps: { projectsDir: string }) => {
      const store = actual.createMemoryStore(deps);
      return {
        ...store,
        async write(agentName: string, relPath: string, content: string) {
          const absolutePath = join(deps.projectsDir, 'agents', agentName, 'memory', relPath);
          if (fsGate.matches(absolutePath)) {
            fsGate.entered();
            await fsGate.waitUntilReleased();
          }
          return store.write(agentName, relPath, content);
        },
      };
    },
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connect(config: McpSdkServerConfigWithInstance): Promise<{
  client: Client;
  server: McpSdkServerConfigWithInstance['instance'];
}> {
  const server = config.instance;
  const client = new Client({ name: 'f4-drain-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('e2e: admitted local MCP calls drain before task shutdown', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;
  const connections: Array<{
    client: Client;
    server: McpSdkServerConfigWithInstance['instance'];
  }> = [];

  afterEach(async () => {
    fsGate.release();
    await raven?.stop();
    for (const { client, server } of connections.splice(0)) {
      await client.close();
      await server.close();
    }
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
  });

  async function boot(backend: AgentBackend): Promise<{
    started: Promise<BackendOptions>;
    completions: AgentTaskCompleteEvent[];
    requests: AgentTaskRequestEvent[];
    memoryPath: string;
  }> {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-mcp-drain-'));
    const paths = createRavenTestFixture(root);
    const started = deferred<BackendOptions>();
    raven = await createRaven(buildTestConfig(), {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: async (options) => {
        started.resolve(options);
        return backend(options);
      },
    });
    await raven.start();
    const completions: AgentTaskCompleteEvent[] = [];
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => {
      completions.push(event);
    });
    const requests: AgentTaskRequestEvent[] = [];
    raven.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      requests.push(event);
    });
    const memoryPath = join(paths.projectsDir, 'agents', 'raven', 'memory', 'held.md');
    raven.eventBus.emit({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'f4-drain-test',
      type: 'agent:task:request',
      payload: {
        taskId: 'f4-drain-task',
        projectId: 'meta',
        namedAgentId: 'raven',
        skillName: 'orchestrator',
        prompt: 'Use the available tools for this drain test.',
        priority: 'normal',
        mcpServers: {},
      },
    } satisfies AgentTaskRequestEvent);
    return { started: started.promise, completions, requests, memoryPath };
  }

  it('holds shutdown until a real memory mutation commits, then emits one cancelled outcome', async () => {
    const backendSettled = deferred<boolean>();
    const backend: AgentBackend = async (options) => {
      await new Promise<boolean>((resolve) => {
        if (options.signal?.aborted) resolve(true);
        else options.signal?.addEventListener('abort', () => resolve(true), { once: true });
      });
      backendSettled.resolve(true);
      return { result: 'backend stopped', success: true, errors: [] };
    };
    const { started, completions, memoryPath } = await boot(backend);
    const options = await started;
    const ravenMcp = await connect(options.mcpServers.raven as McpSdkServerConfigWithInstance);
    const memoryMcp = await connect(options.mcpServers.memory as McpSdkServerConfigWithInstance);
    connections.push(ravenMcp, memoryMcp);

    expect(
      await ravenMcp.client.callTool({
        name: 'classify_request',
        arguments: { mode: 'direct', reason: 'drain test' },
      }),
    ).toMatchObject({ content: [{ text: expect.stringContaining('direct') }] });

    fsGate.arm(memoryPath);
    const memoryWrite = memoryMcp.client.callTool({
      name: 'memory_write',
      arguments: { path: 'held.md', content: 'committed after shutdown waits' },
    });
    await fsGate.waitUntilEntered();

    const abortObserved = new Promise<boolean>((resolve) => {
      if (options.signal?.aborted) resolve(true);
      else options.signal?.addEventListener('abort', () => resolve(true), { once: true });
    });
    const stop = raven!.stop();
    await abortObserved;
    await backendSettled.promise;
    expect(raven!.db.get<{ ok: number }>('SELECT 1 AS ok')).toEqual({ ok: 1 });
    expect(existsSync(memoryPath)).toBe(false);
    expect(completions).toHaveLength(0);

    let settled = false;
    void stop.then(() => {
      settled = true;
    });
    await new Promise<boolean>((resolve) => setImmediate(() => resolve(true)));
    expect(settled).toBe(false);

    fsGate.release();
    await expect(memoryWrite).resolves.toMatchObject({ isError: true });
    expect(existsSync(memoryPath)).toBe(true);
    await stop;
    expect(readFileSync(memoryPath, 'utf8')).toBe('committed after shutdown waits');
    expect(
      parse(
        readFileSync(
          join(root!, 'projects', 'system', 'tasks', 'runs', 'f4-drain-task.yaml'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      id: 'f4-drain-task',
      status: 'cancelled',
      blocked: false,
      completedAt: expect.any(String),
    });
    expect(completions).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          taskId: 'f4-drain-task',
          success: false,
          cancelled: true,
        }),
      }),
    ]);

    const lateWritePath = join(root!, 'projects', 'agents', 'raven', 'memory', 'late.md');
    const lateWrite = await memoryMcp.client.callTool({
      name: 'memory_write',
      arguments: { path: 'late.md', content: 'must not be written' },
    });
    expect(lateWrite).toMatchObject({ isError: true });
    expect(existsSync(lateWritePath)).toBe(false);
  }, 15_000);

  it('drains an admitted mutation when the backend completes normally', async () => {
    const backendDone = deferred<boolean>();
    const backend: AgentBackend = async () => {
      await backendDone.promise;
      return { result: 'completed', success: true, errors: [] };
    };
    const { started, completions, memoryPath } = await boot(backend);
    const options = await started;
    const memoryMcp = await connect(options.mcpServers.memory as McpSdkServerConfigWithInstance);
    connections.push(memoryMcp);

    fsGate.arm(memoryPath);
    const memoryWrite = memoryMcp.client.callTool({
      name: 'memory_write',
      arguments: { path: 'held.md', content: 'normal completion waits too' },
    });
    await fsGate.waitUntilEntered();
    backendDone.resolve(true);
    await new Promise<boolean>((resolve) => setImmediate(() => resolve(true)));
    expect(completions).toHaveLength(0);
    expect(existsSync(memoryPath)).toBe(false);

    fsGate.release();
    await expect(memoryWrite).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('ok') }],
    });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      payload: { taskId: 'f4-drain-task', success: true, cancelled: false },
    });
    expect(existsSync(memoryPath)).toBe(true);
    expect(readFileSync(memoryPath, 'utf8')).toBe('normal completion waits too');
    expect(
      parse(
        readFileSync(
          join(root!, 'projects', 'system', 'tasks', 'runs', 'f4-drain-task.yaml'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      id: 'f4-drain-task',
      status: 'completed',
      blocked: false,
      completedAt: expect.any(String),
    });
  }, 15_000);

  it('keeps validator admission headroom at maxConcurrent=1', async () => {
    const treeCreated = deferred<string>();
    const order: string[] = [];
    const backend: AgentBackend = async (options) => {
      if (options.prompt.startsWith('Evaluate this task result.')) {
        order.push('evaluator-start');
        return {
          result: JSON.stringify({ passed: true, reason: 'Evaluator approved the worker result.' }),
          success: true,
          errors: [],
        };
      }
      if (options.prompt.includes('validator headroom worker')) {
        order.push('worker-start');
        const workerMcp = await connect(options.mcpServers.raven as McpSdkServerConfigWithInstance);
        connections.push(workerMcp);
        const completion = await workerMcp.client.callTool({
          name: 'complete_task',
          arguments: { summary: 'Worker completed while validation runs.' },
        });
        expect(completion).not.toMatchObject({ isError: true });
        order.push('worker-complete');
        return { result: 'worker backend complete', success: true, errors: [] };
      }

      order.push('initial-start');
      const initialMcp = await connect(options.mcpServers.raven as McpSdkServerConfigWithInstance);
      connections.push(initialMcp);
      const created = await initialMcp.client.callTool({
        name: 'create_task_tree',
        arguments: {
          plan: 'Complete one validated worker task with max concurrency one.',
          autoApprove: true,
          tasks: [
            {
              id: 'validator-headroom-worker',
              type: 'agent',
              title: 'Validated worker',
              prompt: 'validator headroom worker',
              blockedBy: [],
              validation: {
                requireArtifacts: false,
                evaluator: true,
                evaluatorCriteria: 'The worker must report completion.',
                qualityReview: false,
                maxRetries: 0,
                retryBackoffMs: 0,
                onMaxRetriesFailed: 'fail',
              },
            },
          ],
        },
      });
      expect(created).not.toMatchObject({ isError: true });
      const text = z
        .object({
          content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
        })
        .parse(created).content[0].text;
      treeCreated.resolve((JSON.parse(text) as { treeId: string }).treeId);
      order.push('initial-tree-created');
      return { result: 'tree created', success: true, errors: [] };
    };

    const { started, completions, requests } = await boot(backend);
    await started;
    const treeId = await treeCreated.promise;
    const baseUrl = `http://127.0.0.1:${String(raven!.port)}`;
    await vi.waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/api/task-trees/${treeId}`);
        expect(response.status).toBe(200);
        const tree = (await response.json()) as { status: string };
        expect(tree.status).toBe('completed');
      },
      { timeout: 8_000, interval: 25 },
    );

    const workerRequest = requests.find(
      (request) => request.payload.prompt === 'validator headroom worker',
    );
    const evaluatorRequest = requests.find((request) =>
      request.payload.prompt.startsWith('Evaluate this task result.'),
    );
    expect(workerRequest).toBeDefined();
    expect(evaluatorRequest).toBeDefined();
    await vi.waitFor(() => expect(completions).toHaveLength(3));
    const evaluatorCompletionIndex = completions.findIndex(
      (event) => event.payload.taskId === evaluatorRequest?.payload.taskId,
    );
    const workerCompletionIndex = completions.findIndex(
      (event) => event.payload.taskId === workerRequest?.payload.taskId,
    );
    expect(evaluatorCompletionIndex).toBeGreaterThan(-1);
    expect(workerCompletionIndex).toBeGreaterThan(evaluatorCompletionIndex);
    expect(order).toEqual([
      'initial-start',
      'initial-tree-created',
      'worker-start',
      'evaluator-start',
      'worker-complete',
    ]);
    expect(completions[workerCompletionIndex]).toMatchObject({
      payload: { success: true, cancelled: false },
    });
    expect(completions[evaluatorCompletionIndex]).toMatchObject({
      payload: { success: true, cancelled: false },
    });
  }, 15_000);
});
