import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEventListeners } from 'node:events';

// Mock the SDK query function to capture what options it receives
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';

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
        yield { type: 'result', result: 'late success', subtype: 'success' };
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
    if (outcome === 'error') await expect(work).rejects.toThrow('fake query failure');
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
});
