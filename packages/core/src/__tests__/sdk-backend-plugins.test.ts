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
    });
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
    expect(callArgs.options.plugins).toEqual(plugins);
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
    expect(callArgs.options.plugins).toBeUndefined();
  });
});
