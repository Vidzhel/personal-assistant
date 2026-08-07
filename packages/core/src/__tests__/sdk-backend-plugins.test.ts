import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('bridges an already-aborted caller signal into the SDK-native abortController', async () => {
    const backend = createSdkBackend();
    const controller = new AbortController();
    controller.abort();

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
      signal: controller.signal,
    });

    const callArgs = mockQuery.mock.calls[0][0];
    const passedController = callArgs.options!.abortController as AbortController;
    expect(passedController.signal.aborted).toBe(true);
  });

  it('propagates a caller-signal abort that happens after query() was called', async () => {
    let capturedController: AbortController | undefined;
    mockQuery.mockImplementation(async function* (queryArgs: {
      options: { abortController?: AbortController };
    }) {
      capturedController = queryArgs.options.abortController;
      yield { type: 'result', result: 'ok', subtype: 'success' };
    } as unknown as typeof query);

    const backend = createSdkBackend();
    const controller = new AbortController();

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
      signal: controller.signal,
    });

    controller.abort();
    expect(capturedController?.signal.aborted).toBe(true);
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
