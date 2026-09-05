import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTaskCompleteEvent, AgentTaskRequestEvent } from '@raven/shared';
import { AgentManager } from '../agent-manager/agent-manager.ts';
import { setActiveBackend } from '../agent-manager/agent-session.ts';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';
import type { WorkspaceExecutionResolver } from '../project-manager/workspace-execution.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { setConfig } from '../config.ts';
import { buildTestConfig } from './fixtures/raven-fixture.ts';

describe('workspace admission lifetime', () => {
  let manager: AgentManager;
  let events: EventBus;
  let revision: string;
  let calls: BackendOptions[];
  let completions: AgentTaskCompleteEvent[];
  let release: (() => void) | undefined;

  beforeEach(() => {
    setConfig({ ...buildTestConfig(), RAVEN_MAX_CONCURRENT_AGENTS: 1 });
    events = new EventBus();
    revision = 'original';
    calls = [];
    completions = [];
    const resolver: WorkspaceExecutionResolver = {
      resolve: () => ({
        cwd: '/tmp/workspace-fixture',
        additionalDirectories: [],
        settingSources: [],
        mode: 'full',
        revision,
      }),
    };
    manager = new AgentManager({ eventBus: events, workspaceExecution: resolver });
    events.on<AgentTaskCompleteEvent>('agent:task:complete', (event) => completions.push(event));
    setActiveBackend(async (options) => {
      calls.push(options);
      if (options.prompt === 'hold')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { result: 'done', success: true, errors: [] };
    });
  });

  afterEach(async () => {
    release?.();
    await manager.stop();
    events.removeAllListeners();
    release = undefined;
  });

  function request(
    taskId: string,
    overrides: Partial<AgentTaskRequestEvent['payload']> = {},
  ): void {
    events.emit({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:request',
      payload: {
        taskId,
        projectId: 'alpha',
        prompt: 'run',
        skillName: 'orchestrator',
        priority: 'normal',
        mcpServers: {},
        ...overrides,
      },
    } satisfies AgentTaskRequestEvent);
  }

  it('rejects stale queued work and stale running completion without dispatching again', async () => {
    request('running', { prompt: 'hold' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    request('queued');
    expect(manager.getQueueLength()).toBe(1);
    revision = 'revoked';
    release!();
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(calls).toHaveLength(1);
    expect(completions.every((event) => !event.payload.success)).toBe(true);
    expect(completions[1].payload.errors?.join(' ')).toContain('grant changed');
    request('fresh');
    await vi.waitFor(() => expect(completions).toHaveLength(3));
    expect(calls).toHaveLength(2);
    expect(completions[2].payload.success).toBe(true);
  });

  it('does not grant validators the project native workspace mode', async () => {
    request('validator', { internal: 'validator' });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(calls[0].permissionMode).toBe('default');
    expect(calls[0].cwd).not.toBe('/tmp/workspace-fixture');
    expect(calls[0].settingSources).toEqual([]);
  });

  it('closes hooks on stop before an uncooperative provider finishes', async () => {
    request('running', { prompt: 'hold' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const stop = manager.stop();
    const hook = calls[0].hooks!.PreToolUse![0].hooks[0];
    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo late' },
        tool_use_id: 'late',
        session_id: 'sdk',
        transcript_path: '/tmp/test',
        cwd: calls[0].cwd!,
      },
      'late',
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    release!();
    await stop;
    expect(completions[0].payload.success).toBe(false);
  });
});
