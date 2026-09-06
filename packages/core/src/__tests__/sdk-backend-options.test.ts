import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';

const mockQuery = vi.mocked(query);

function baseOptions(overrides: Partial<BackendOptions> = {}): BackendOptions {
  return {
    prompt: 'test',
    systemPrompt: 'system',
    allowedTools: [],
    model: 'sonnet',
    maxTurns: 3,
    mcpServers: {},
    agents: {},
    onAssistantMessage: () => {},
    onStderr: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async function* () {
    yield { type: 'result', subtype: 'success', result: 'ok' };
  } as unknown as typeof query);
});

describe('SDK backend execution options', () => {
  it('rejects missing nested MCP bindings before starting the SDK', async () => {
    const result = await createSdkBackend()(
      baseOptions({
        agents: { helper: { description: 'helper', prompt: 'help', mcpServers: ['missing'] } },
      }),
    );
    expect(result.success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('isolates settings and MCP configuration by default', async () => {
    await createSdkBackend()(baseOptions());

    const options = mockQuery.mock.calls[0][0].options!;
    expect(options.permissionMode).toBe('default');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toBeUndefined();
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it.each(['auto', 'bypassPermissions'] as const)('forwards %s permission mode', async (mode) => {
    await createSdkBackend()(baseOptions({ permissionMode: mode }));

    const options = mockQuery.mock.calls[0][0].options!;
    expect(options.permissionMode).toBe(mode);
    expect(options.allowDangerouslySkipPermissions).toBe(
      mode === 'bypassPermissions' ? true : undefined,
    );
  });

  it('forwards workspace, settings, hooks, MCP, and nested agents', async () => {
    const hooks = { PreToolUse: [] } as NonNullable<BackendOptions['hooks']>;
    const mcpServers = { raven: { type: 'sdk', name: 'raven' } };
    const agents = {
      helper: { description: 'helper', prompt: 'help' },
    } as BackendOptions['agents'];
    await createSdkBackend()(
      baseOptions({
        cwd: '/tmp/project',
        additionalDirectories: ['/tmp/repository'],
        settingSources: ['project', 'local'],
        hooks,
        mcpServers,
        agents,
      }),
    );

    const options = mockQuery.mock.calls[0][0].options!;
    expect(options.cwd).toBe('/tmp/project');
    expect(options.additionalDirectories).toEqual(['/tmp/repository']);
    expect(options.settingSources).toEqual(['project', 'local']);
    expect(options.hooks).toBe(hooks);
    expect(options.mcpServers).toBe(mcpServers);
    expect(options.agents).toEqual({ helper: { ...agents.helper, tools: [] } });
  });

  it('uses strict parent MCP connections with explicit nested tool scope', async () => {
    const tools = ['Read', 'mcp__ticktick__*'];
    await createSdkBackend()(
      baseOptions({
        mcpServers: { ticktick: { type: 'http', url: 'https://example.test/mcp' } },
        agents: {
          planner: { description: 'planner', prompt: 'plan', tools, mcpServers: ['ticktick'] },
        },
      }),
    );
    const options = mockQuery.mock.calls[0][0].options!;
    expect(options.strictMcpConfig).toBe(true);
    expect(options.agents?.planner.tools).toEqual(tools);
    expect(options.agents?.planner.mcpServers).toBeUndefined();
    expect(options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });
});
