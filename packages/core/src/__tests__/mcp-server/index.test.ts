import { describe, it, expect, vi } from 'vitest';
import { createRavenMcp } from '../../mcp-server/index.ts';
import type { RavenMcpDeps } from '../../mcp-server/types.ts';
import type { ScopeContext } from '../../mcp-server/scope.ts';

function createMockDeps(): RavenMcpDeps {
  return {
    executionEngine: {
      onTaskCompleted: vi.fn().mockResolvedValue(undefined),
      onTaskBlocked: vi.fn(),
      createTree: vi.fn(),
      startTree: vi.fn().mockResolvedValue(undefined),
      getTree: vi.fn(),
    } as any,
    messageStore: {
      appendMessage: vi.fn().mockReturnValue('msg-1'),
      getMessages: vi.fn().mockReturnValue([]),
    } as any,
    eventBus: { emit: vi.fn() } as any,
  };
}

describe('createRavenMcp', () => {
  it('returns McpSdkServerConfigWithInstance', () => {
    const deps = createMockDeps();
    const scope: ScopeContext = { role: 'task', taskId: 'task-1', treeId: 'tree-1' };
    const config = createRavenMcp(deps, scope);

    expect(config.type).toBe('sdk');
    expect(config.name).toBe('raven');
    expect(config.instance).toBeDefined();
  });

  it('creates config for system scope', () => {
    const deps = createMockDeps();
    const scope: ScopeContext = { role: 'system' };
    const config = createRavenMcp(deps, scope);
    expect(config.instance).toBeDefined();
  });
});
