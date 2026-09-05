import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEventListeners } from 'node:events';

// Mock the SDK query function to capture what options it receives
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';
import { runCancellableBackend } from '../agent-manager/agent-backend.ts';

const mockQuery = vi.mocked(query);

describe('SDK backend plugins', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', result: 'ok', subtype: 'success' };
    } as unknown as typeof query);
  });

  it('passes plugins to query options when provided', async () => {
    const backend = createSdkBackend();
    const plugins = [
      { type: 'local' as const, path: '/vendor/anthropic-skills' },
      { type: 'local' as const, path: '/vendor/ffmpeg-master' },
    ];

    await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: ['Read'],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      plugins,
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options!.plugins).toEqual(plugins);
  });

  it('omits plugins from query options when empty', async () => {
    const backend = createSdkBackend();

    await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: ['Read'],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      plugins: [],
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options!.plugins).toBeUndefined();
  });
});

describe('SDK backend cancellation + session id (F2)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', result: 'ok', subtype: 'success' };
    } as unknown as typeof query);
  });

  it('always sets an SDK-native abortController on queryOptions, even with no caller signal', async () => {
    const backend = createSdkBackend();

    await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: ['Read'],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options!.abortController).toBeInstanceOf(AbortController);
  });

  it('does not start the SDK for an already-aborted caller signal', async () => {
    const backend = createSdkBackend();
    const controller = new AbortController();
    controller.abort();

    const result = await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: ['Read'],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
      signal: controller.signal,
    });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result).toEqual({ result: '', success: false, errors: ['cancelled'] });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('aborts an in-flight SDK query and releases its bridge when iteration closes', async () => {
    let capturedController: AbortController | undefined;
    let started!: () => void;
    let release!: () => void;
    let closed = false;
    const startedQuery = new Promise<void>((resolve) => {
      started = resolve;
    });
    const heldQuery = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockQuery.mockImplementation(async function* (queryArgs: {
      options: { abortController?: AbortController };
    }) {
      capturedController = queryArgs.options.abortController;
      started();
      try {
        await heldQuery;
        yield {
          type: 'result',
          result: 'late success',
          subtype: 'success',
          total_cost_usd: 0.37,
          modelUsage: {},
        };
      } finally {
        closed = true;
      }
    } as unknown as typeof query);

    const controller = new AbortController();
    const work = createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: vi.fn(),
      onStderr: vi.fn(),
      signal: controller.signal,
    });
    await startedQuery;
    expect(capturedController?.signal.aborted).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    expect(capturedController?.signal.aborted).toBe(true);
    release();
    expect(await work).toMatchObject({ success: false, errors: ['cancelled'] });
    expect(closed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['success', 'error'])('removes the abort bridge after query %s', async (outcome) => {
    let capturedController: AbortController | undefined;
    mockQuery.mockImplementation(async function* (queryArgs: {
      options: { abortController?: AbortController };
    }) {
      capturedController = queryArgs.options.abortController;
      if (outcome === 'error') throw new Error('fake query failure');
      yield { type: 'result', result: 'ok', subtype: 'success' };
    } as unknown as typeof query);
    const controller = new AbortController();
    const work = createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: vi.fn(),
      onStderr: vi.fn(),
      signal: controller.signal,
    });
    if (outcome === 'error')
      expect(await work).toMatchObject({ success: false, errors: ['fake query failure'] });
    else expect(await work).toMatchObject({ success: true });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    controller.abort();
    expect(capturedController?.signal.aborted).toBe(false);
  });

  it('calls onSessionId as soon as the system/init message arrives', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-abc-123' };
      yield { type: 'result', result: 'ok', subtype: 'success' };
    } as unknown as typeof query);

    const backend = createSdkBackend();
    const onSessionId = vi.fn();

    await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: ['Read'],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
      onSessionId,
    });

    expect(onSessionId).toHaveBeenCalledWith('sdk-abc-123');
  });

  it('sums validated nested model costs from the latest cumulative result', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'first',
        total_cost_usd: 0.1,
        modelUsage: { sonnet: { costUSD: 0.1 } },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'latest',
        total_cost_usd: 0.3,
        modelUsage: {
          sonnet: { costUSD: 0.2 },
          haiku: { costUSD: 0.15 },
        },
      };
    } as unknown as typeof query);

    const result = await createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    expect(result.estimatedCostUsd).toBeCloseTo(0.35);
    expect(result.result).toBe('latest');
  });

  it('uses total cost only for reliable result subtypes and leaves malformed error cost unknown', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: '',
        total_cost_usd: 0,
        modelUsage: {},
      };
    } as unknown as typeof query);

    const result = await createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    expect(result).not.toHaveProperty('estimatedCostUsd');
  });

  it('falls back to a finite cumulative total when model usage is malformed', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_max_budget_usd',
        result: '',
        total_cost_usd: 0.27,
        modelUsage: { sonnet: { costUSD: 'invalid' } },
      };
    } as unknown as typeof query);

    const result = await createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    expect(result.estimatedCostUsd).toBe(0.27);
  });

  it('does not trust a zeroed crash usage, but keeps a positive crash usage', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: '',
        total_cost_usd: 0,
        modelUsage: { sonnet: { costUSD: 0 } },
      };
    } as unknown as typeof query);

    const zeroCost = await createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });
    expect(zeroCost).not.toHaveProperty('estimatedCostUsd');

    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: '',
        total_cost_usd: 0,
        modelUsage: { sonnet: { costUSD: 0.08 } },
      };
    } as unknown as typeof query);

    const positiveCost = await createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });
    expect(positiveCost.estimatedCostUsd).toBe(0.08);
  });

  it('clears a prior estimate when the latest cumulative result is invalid', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'first',
        total_cost_usd: 0.1,
        modelUsage: { sonnet: { costUSD: 0.1 } },
      };
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        result: '',
        total_cost_usd: Number.NaN,
        modelUsage: { sonnet: { costUSD: 'unknown' } },
      };
    } as unknown as typeof query);

    const result = await createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    expect(result).not.toHaveProperty('estimatedCostUsd');
  });

  it('retains a trusted cost when SDK iteration throws after a result', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-failed' };
      yield {
        type: 'result',
        subtype: 'error_max_turns',
        result: 'partial',
        total_cost_usd: 0.42,
        modelUsage: { sonnet: { costUSD: 0.42 } },
      };
      throw new Error('stream disconnected');
    } as unknown as typeof query);

    const result = await createSdkBackend()({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    expect(result).toMatchObject({
      sessionId: 'sdk-failed',
      result: 'partial',
      success: false,
      estimatedCostUsd: 0.42,
    });
    expect(result.errors).toContain('stream disconnected');
  });

  it('forwards maxBudgetUsd to the SDK query', async () => {
    const backend = createSdkBackend();
    await backend({
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'sonnet',
      maxTurns: 5,
      maxBudgetUsd: 0.23,
      mcpServers: {},
      agents: {},
      onAssistantMessage: () => {},
      onStderr: () => {},
    });

    expect(mockQuery.mock.calls[0]?.[0].options?.maxBudgetUsd).toBe(0.23);
  });

  it('preserves trusted cost when cancellation forces the outer result', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = runCancellableBackend(
      async () => {
        await held;
        return { result: 'late', success: true, errors: [], estimatedCostUsd: 0.19 };
      },
      {
        prompt: 'test',
        systemPrompt: 'test',
        allowedTools: [],
        model: 'sonnet',
        maxTurns: 5,
        mcpServers: {},
        agents: {},
        onAssistantMessage: () => {},
        onStderr: () => {},
        signal: controller.signal,
      },
    );
    controller.abort();
    release();

    await expect(work).resolves.toMatchObject({
      result: '',
      success: false,
      errors: ['cancelled'],
      estimatedCostUsd: 0.19,
    });
  });
});
