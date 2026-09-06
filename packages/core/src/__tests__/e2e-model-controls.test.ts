import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentTaskRequestEvent,
  AgentTaskCompleteEvent,
  ModelCatalogSnapshot,
  ModelConfig,
} from '@raven/shared';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import type { DiscoveredModel } from '../agent-registry/model-catalog.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { StoredMessage } from '../session-manager/message-store.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const DISCOVERED_MODELS = [
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5',
    displayName: 'Haiku fixture',
    description: 'Fast fixture model',
    supportsEffort: true,
    supportedEffortLevels: ['low'],
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet fixture',
    description: 'General fixture model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
  },
  {
    value: 'claude-fable-5-1',
    displayName: 'Fable fixture',
    description: 'Mandatory-thinking fixture model',
    supportsEffort: true,
    supportedEffortLevels: ['high'],
    supportsAdaptiveThinking: true,
  },
] satisfies DiscoveredModel[];

interface CapturedBackendCall {
  model: string;
  effort?: ModelConfig['effort'];
  thinking?: ModelConfig['thinking'];
  prompt: string;
  systemPrompt: string;
  resume?: string;
}

interface FakeBackendControl {
  backend: AgentBackend;
  calls: CapturedBackendCall[];
  blockerStarted: Promise<void>;
  releaseBlocker(): void;
}

interface BootOptions {
  reuseRoot?: boolean;
  initializeCatalog?: boolean;
  createConversation?: boolean;
  modelDiscovery?: (signal: AbortSignal) => Promise<readonly DiscoveredModel[]>;
}

function fakeBackend(): FakeBackendControl {
  const calls: CapturedBackendCall[] = [];
  let releaseBlocker = (): void => undefined;
  let markBlockerStarted = (): void => undefined;
  const blocker = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const blockerStarted = new Promise<void>((resolve) => {
    markBlockerStarted = resolve;
  });
  let coldSessions = 0;
  const backend: AgentBackend = async (options: BackendOptions) => {
    calls.push({
      model: options.model,
      effort: options.effort,
      thinking: options.thinking,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      resume: options.resume,
    });
    const sdkSessionId = options.resume ?? `fake-sdk-${String(++coldSessions)}`;
    options.onSessionId?.(sdkSessionId);
    if (options.prompt.includes('BLOCKER')) {
      markBlockerStarted();
      await blocker;
    }
    const result = options.prompt.includes('BLOCKER-PREDECESSOR')
      ? 'PREDECESSOR-ANSWER-998'
      : `Fixture reply ${String(calls.length)}`;
    options.onAssistantMessage(result);
    return { sessionId: sdkSessionId, result, success: true, errors: [] };
  };
  return { backend, calls, blockerStarted, releaseBlocker };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for composed work');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('e2e: composed session model controls', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;
  let backendControl: FakeBackendControl | undefined;
  let baseUrl = '';
  let projectId = '';
  let sessionId = '';
  let completions: AgentTaskCompleteEvent[] = [];
  let requests: AgentTaskRequestEvent[] = [];
  const sockets: WebSocket[] = [];

  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  }

  async function boot(options: BootOptions = {}): Promise<void> {
    if (!options.reuseRoot) root = mkdtempSync(join(tmpdir(), 'raven-e2e-model-controls-'));
    if (!root) throw new Error('A reusable test root is required');
    const fixture = createRavenTestFixture(root);
    const agentPath = join(fixture.projectsDir, 'agents', 'raven', 'agent.yaml');
    mkdirSync(dirname(agentPath), { recursive: true });
    writeFileSync(
      agentPath,
      JSON.stringify({
        name: 'raven',
        displayName: 'Raven fixture',
        description: 'Canonical fixture agent',
        isDefault: true,
        skills: [],
        instructions: 'CANONICAL-YAML-INSTRUCTION',
        model: 'sonnet',
      }),
    );
    backendControl = fakeBackend();
    raven = await createRaven(
      { ...buildTestConfig(), CLAUDE_MODEL: 'sonnet', RAVEN_MAX_CONCURRENT_AGENTS: 1 },
      {
        ...fixture,
        apiHost: '127.0.0.1',
        skipSuites: true,
        agentBackend: backendControl.backend,
        modelDiscovery: options.modelDiscovery ?? (async () => DISCOVERED_MODELS),
      },
    );
    completions = [];
    requests = [];
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => {
      completions.push(event);
    });
    raven.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      requests.push(event);
    });
    await raven.start();
    baseUrl = `http://127.0.0.1:${String(raven.port)}`;

    if (options.initializeCatalog !== false) {
      const catalog = await request('/api/models');
      expect(catalog.status).toBe(200);
      const snapshot = (await catalog.json()) as ModelCatalogSnapshot;
      expect(snapshot.error).toBeNull();
      expect(snapshot.stale).toBe(false);
      expect(snapshot.models.map((model) => model.id)).toEqual(
        expect.arrayContaining(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-fable-5-1']),
      );
    }

    if (options.createConversation !== false) {
      const project = await request('/api/projects', 'POST', { name: 'Model Controls Fixture' });
      expect(project.status).toBe(200);
      projectId = ((await project.json()) as { id: string }).id;
      const session = await request(`/api/projects/${projectId}/sessions`, 'POST');
      expect(session.status).toBe(200);
      sessionId = ((await session.json()) as { id: string }).id;
    }
  }

  async function sendChat(message: string, modelConfig?: ModelConfig): Promise<Response> {
    return request(`/api/projects/${projectId}/chat`, 'POST', {
      sessionId,
      message,
      ...(modelConfig ? { modelConfig } : {}),
    });
  }

  afterEach(async () => {
    backendControl?.releaseBlocker();
    await Promise.all(
      sockets.splice(0).map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) return resolve();
            socket.once('close', () => resolve());
            socket.close();
          }),
      ),
    );
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    backendControl = undefined;
    root = undefined;
  });

  it('discovers models, persists layered defaults, and rejects invalid HTTP and WS turns', async () => {
    await boot();
    const projectConfig = {
      model: 'sonnet',
      effort: 'high' as const,
      thinking: 'adaptive' as const,
    };
    const workspace = await request(`/api/projects/${projectId}/workspace`, 'PUT', {
      execution: { modelConfig: projectConfig },
    });
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      execution: { modelConfig: projectConfig },
      effectiveModelConfig: {
        model: 'claude-sonnet-5',
        effort: 'high',
        thinking: 'adaptive',
      },
    });

    const sessionConfig = { effort: 'medium' as const };
    const session = await request(`/api/sessions/${sessionId}`, 'PATCH', {
      modelConfig: sessionConfig,
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      modelConfig: sessionConfig,
      effectiveModelConfig: {
        model: 'claude-sonnet-5',
        effort: 'medium',
        thinking: 'adaptive',
      },
    });

    const rejectedHttp = await sendChat('HTTP MUST NOT BE STORED', {
      model: 'haiku',
      effort: 'max',
    });
    expect(rejectedHttp.status).toBe(400);
    expect(await rejectedHttp.text()).toContain('does not support effort');

    const socket = new WebSocket(`ws://127.0.0.1:${String(raven!.port)}/ws`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const received: unknown[] = [];
    socket.on('message', (raw: RawData) => received.push(JSON.parse(raw.toString())));
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        requestId: 'invalid-ws-model',
        projectId,
        sessionId,
        message: 'WS MUST NOT BE STORED',
        modelConfig: {
          model: 'claude-fable-5-1',
          effort: 'high',
          thinking: 'disabled',
        },
      }),
    );
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({
      type: 'chat:error',
      data: {
        requestId: 'invalid-ws-model',
        projectId,
        sessionId,
        error: expect.stringContaining('requires adaptive thinking'),
      },
    });

    const messages = (await (
      await request(`/api/sessions/${sessionId}/messages`)
    ).json()) as StoredMessage[];
    expect(messages).toEqual([]);
    expect(backendControl!.calls).toEqual([]);
  });

  it('resumes unchanged settings and uses bounded history after a model switch', async () => {
    await boot();
    const selected = await request(`/api/sessions/${sessionId}`, 'PATCH', {
      modelConfig: { model: 'sonnet', effort: 'high', thinking: 'adaptive' },
    });
    expect(selected.status).toBe(200);

    expect((await sendChat('Remember the distinctive fact ORANGE-COMET-731.')).status).toBe(200);
    await waitFor(() => completions.length === 1);
    expect((await sendChat('What did I ask you to remember?')).status).toBe(200);
    await waitFor(() => completions.length === 2);

    const calls = backendControl!.calls;
    expect(calls[0]).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
      thinking: 'adaptive',
    });
    expect(calls[0].resume).toBeUndefined();
    expect(calls[0].systemPrompt).toContain('CANONICAL-YAML-INSTRUCTION');
    expect(calls[1].resume).toBe('fake-sdk-1');

    const switched = await request(`/api/sessions/${sessionId}`, 'PATCH', {
      modelConfig: { model: 'haiku', effort: 'low', thinking: 'disabled' },
    });
    expect(switched.status).toBe(200);
    expect((await sendChat('Continue after the model switch.')).status).toBe(200);
    await waitFor(() => completions.length === 3);

    expect(calls[2]).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low',
      thinking: 'disabled',
    });
    expect(calls[2].resume).toBeUndefined();
    expect(calls[2].prompt).toContain('Earlier Raven conversation');
    expect(calls[2].prompt).toContain('ORANGE-COMET-731');
    expect(calls[2].prompt).toContain('Current owner message:\nContinue after the model switch.');
    expect(Buffer.byteLength(calls[2].prompt, 'utf8')).toBeLessThan(25 * 1024);
  });

  it('uses the active session for HTTP and WS preflight when sessionId is omitted', async () => {
    await boot();
    expect(
      (
        await request(`/api/projects/${projectId}/workspace`, 'PUT', {
          execution: { modelConfig: { model: 'haiku' } },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/sessions/${sessionId}`, 'PATCH', {
          modelConfig: { model: 'sonnet' },
        })
      ).status,
    ).toBe(200);
    const response = await request(`/api/projects/${projectId}/chat`, 'POST', {
      message: 'Use the selected conversation without an explicit ID.',
      modelConfig: { effort: 'high' },
    });
    expect(response.status).toBe(200);
    await waitFor(() => completions.length === 1);
    expect(backendControl!.calls[0]).toMatchObject({ model: 'claude-sonnet-5', effort: 'high' });
    expect(requests[0].payload.sessionId).toBe(sessionId);
    const socket = new WebSocket(`ws://127.0.0.1:${String(raven!.port)}/ws`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        projectId,
        requestId: 'implicit-session-ws',
        message: 'Continue the selected conversation through WebSocket.',
        modelConfig: { effort: 'high' },
      }),
    );
    await waitFor(() => completions.length === 2);
    expect(backendControl!.calls[1]).toMatchObject({ model: 'claude-sonnet-5', effort: 'high' });
    expect(requests[1].payload.sessionId).toBe(sessionId);
  });

  it('keeps a queued turn model snapshot when session and project defaults change', async () => {
    await boot();
    expect(
      (
        await request(`/api/projects/${projectId}/workspace`, 'PUT', {
          execution: {
            modelConfig: { model: 'sonnet', effort: 'high', thinking: 'adaptive' },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/sessions/${sessionId}`, 'PATCH', {
          modelConfig: { effort: 'medium' },
        })
      ).status,
    ).toBe(200);

    expect((await sendChat('BLOCKER holds the only execution slot.')).status).toBe(200);
    await backendControl!.blockerStarted;
    expect((await sendChat('QUEUED must retain its admitted settings.')).status).toBe(200);
    await waitFor(() => requests.length === 2);
    expect(backendControl!.calls).toHaveLength(1);

    expect(
      (
        await request(`/api/sessions/${sessionId}`, 'PATCH', {
          modelConfig: { model: 'haiku', effort: 'low', thinking: 'disabled' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/projects/${projectId}/workspace`, 'PUT', {
          execution: {
            modelConfig: { model: 'haiku', effort: 'low', thinking: 'disabled' },
          },
        })
      ).status,
    ).toBe(200);

    backendControl!.releaseBlocker();
    await waitFor(() => completions.length === 2);
    expect(backendControl!.calls).toHaveLength(2);
    expect(backendControl!.calls[1]).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'medium',
      thinking: 'adaptive',
    });
    expect(completions[1].payload.success).toBe(true);
    expect(
      raven!.db.get<{ model: string; status: string }>(
        'SELECT model, status FROM model_budget_leases WHERE task_id = ?',
        requests[1].payload.taskId,
      ),
    ).toEqual({ model: 'claude-sonnet-5', status: 'unknown' });
  });

  it('still blocks queued work after the project workspace grant changes', async () => {
    await boot();
    expect((await sendChat('BLOCKER holds the only execution slot.')).status).toBe(200);
    await backendControl!.blockerStarted;
    expect((await sendChat('QUEUED must revalidate its workspace grant.')).status).toBe(200);
    await waitFor(() => requests.length === 2);

    const changed = await request(`/api/projects/${projectId}/workspace`, 'PUT', {
      execution: { mode: 'auto' },
    });
    expect(changed.status).toBe(200);
    backendControl!.releaseBlocker();

    await waitFor(() => completions.length === 2);
    expect(backendControl!.calls).toHaveLength(1);
    expect(completions[1].payload).toMatchObject({
      success: false,
      errors: [expect.stringContaining('Project execution grant changed')],
    });
  });

  it('lazily discovers once after restart before using persisted model controls', async () => {
    let discoveryCalls = 0;
    const discover = async (): Promise<readonly DiscoveredModel[]> => {
      discoveryCalls += 1;
      return DISCOVERED_MODELS;
    };
    await boot({ modelDiscovery: discover });
    expect(discoveryCalls).toBe(1);
    expect(
      (
        await request(`/api/projects/${projectId}/workspace`, 'PUT', {
          execution: {
            modelConfig: { model: 'sonnet', effort: 'high', thinking: 'adaptive' },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/sessions/${sessionId}`, 'PATCH', {
          modelConfig: { model: 'haiku', effort: 'low', thinking: 'disabled' },
        })
      ).status,
    ).toBe(200);

    await raven!.stop();
    raven = undefined;
    backendControl = undefined;
    discoveryCalls = 0;
    await boot({
      reuseRoot: true,
      initializeCatalog: false,
      createConversation: false,
      modelDiscovery: discover,
    });
    expect(discoveryCalls).toBe(0);

    const persistedSession = await request(`/api/sessions/${sessionId}`);
    expect(persistedSession.status).toBe(200);
    expect(await persistedSession.json()).toMatchObject({
      modelConfig: { model: 'haiku', effort: 'low', thinking: 'disabled' },
    });
    const persistedWorkspace = await request(`/api/projects/${projectId}/workspace`);
    expect(persistedWorkspace.status).toBe(200);
    expect(await persistedWorkspace.json()).toMatchObject({
      execution: {
        modelConfig: { model: 'sonnet', effort: 'high', thinking: 'adaptive' },
      },
    });
    expect(discoveryCalls).toBe(0);

    expect((await sendChat('Use persisted settings after restart.')).status).toBe(200);
    await waitFor(() => completions.length === 1);
    expect(discoveryCalls).toBe(1);
    expect(backendControl!.calls).toHaveLength(1);
    expect(backendControl!.calls[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low',
      thinking: 'disabled',
    });
  });

  it('adds a late predecessor answer to cold queued handoff without later user inputs', async () => {
    await boot();
    expect(
      (
        await request(`/api/sessions/${sessionId}`, 'PATCH', {
          modelConfig: { model: 'sonnet', effort: 'high', thinking: 'adaptive' },
        })
      ).status,
    ).toBe(200);
    expect((await sendChat('BLOCKER-PREDECESSOR carries fact BLUE-ANCHOR-441.')).status).toBe(200);
    await backendControl!.blockerStarted;

    expect(
      (
        await request(`/api/sessions/${sessionId}`, 'PATCH', {
          modelConfig: { model: 'haiku', effort: 'low', thinking: 'disabled' },
        })
      ).status,
    ).toBe(200);
    const currentMessage = 'CURRENT-B asks for the predecessor result.';
    const laterMessage = 'LATER-C must not enter the B handoff.';
    expect((await sendChat(currentMessage)).status).toBe(200);
    expect((await sendChat(laterMessage)).status).toBe(200);
    await waitFor(() => requests.length === 3);
    expect(backendControl!.calls).toHaveLength(1);

    backendControl!.releaseBlocker();
    await waitFor(() => backendControl!.calls.length >= 2);
    const currentCall = backendControl!.calls.find((call) => call.prompt.includes(currentMessage));
    expect(currentCall).toBeDefined();
    if (!currentCall) throw new Error('The queued current turn did not reach the fake backend');
    expect(currentCall).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'low',
      thinking: 'disabled',
    });
    expect(currentCall.resume).toBeUndefined();
    expect(currentCall.prompt).toContain('Earlier Raven conversation');
    expect(currentCall.prompt).toContain('BLUE-ANCHOR-441');
    expect(currentCall.prompt).toContain('PREDECESSOR-ANSWER-998');
    expect(currentCall.prompt.split(currentMessage)).toHaveLength(2);
    expect(currentCall.prompt).not.toContain(laterMessage);
  });
});
