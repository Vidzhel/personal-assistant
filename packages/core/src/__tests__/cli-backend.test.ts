import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs/promises for MCP temp file
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn().mockResolvedValue('/tmp/raven-mcp-test'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createCliBackend } from '../agent-manager/cli-backend.ts';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';

const mockSpawn = vi.mocked(spawn);

function createFakeChild(): { child: any; stdout: EventEmitter; stderr: EventEmitter } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  (child as any).stdin = null;
  return { child, stdout, stderr };
}

function baseOpts(overrides: Partial<BackendOptions> = {}): BackendOptions {
  return {
    prompt: 'test prompt',
    systemPrompt: 'You are a test agent',
    allowedTools: ['Read', 'Glob'],
    model: 'claude-sonnet-4-5-20250514',
    maxTurns: 10,
    mcpServers: {},
    agents: {},
    onAssistantMessage: vi.fn(),
    onStderr: vi.fn(),
    ...overrides,
  };
}

describe('CLI Backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures session ID from init message', async () => {
    const { child, stdout } = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const backend = createCliBackend();
    const promise = backend(baseOpts());

    stdout.emit(
      'data',
      Buffer.from('{"type":"system","subtype":"init","session_id":"cli-sess-1"}\n'),
    );
    stdout.emit('data', Buffer.from('{"type":"result","subtype":"success","result":"done"}\n'));
    child.emit('close', 0);

    const result = await promise;
    expect(result.sessionId).toBe('cli-sess-1');
    expect(result.success).toBe(true);
    expect(result.result).toBe('done');
  });

  it('streams assistant messages via callback', async () => {
    const { child, stdout } = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const onAssistantMessage = vi.fn();
    const backend = createCliBackend();
    const promise = backend(baseOpts({ onAssistantMessage }));

    stdout.emit(
      'data',
      Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}]}}\n'),
    );
    stdout.emit('data', Buffer.from('{"type":"result","subtype":"success","result":"ok"}\n'));
    child.emit('close', 0);

    await promise;
    expect(onAssistantMessage).toHaveBeenCalledWith('Hello!');
  });

  it('handles error result', async () => {
    const { child, stdout } = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const backend = createCliBackend();
    const promise = backend(baseOpts());

    stdout.emit(
      'data',
      Buffer.from('{"type":"result","subtype":"error","result":"something broke"}\n'),
    );
    child.emit('close', 1);

    const result = await promise;
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('creates MCP temp file when mcpServers provided', async () => {
    const { child, stdout } = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const backend = createCliBackend();
    const promise = backend(
      baseOpts({
        mcpServers: {
          ticktick: { command: 'npx', args: ['ticktick-mcp'] },
        },
      }),
    );

    // Wait for async setup (mkdtemp, writeFile) before emitting data
    await new Promise((r) => setTimeout(r, 10));

    stdout.emit('data', Buffer.from('{"type":"result","subtype":"success","result":"ok"}\n'));
    child.emit('close', 0);

    await promise;
    expect(mkdtemp).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();
    expect(rm).toHaveBeenCalled();
  });

  it('handles spawn error', async () => {
    const { child } = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const backend = createCliBackend();
    const promise = backend(baseOpts());

    child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('Failed to spawn claude CLI');
  });

  it('forwards stderr to onStderr callback', async () => {
    const { child, stdout, stderr } = createFakeChild();
    mockSpawn.mockReturnValue(child as any);

    const onStderr = vi.fn();
    const backend = createCliBackend();
    const promise = backend(baseOpts({ onStderr }));

    stderr.emit('data', Buffer.from('debug info'));
    stdout.emit('data', Buffer.from('{"type":"result","subtype":"success","result":"ok"}\n'));
    child.emit('close', 0);

    await promise;
    expect(onStderr).toHaveBeenCalledWith('debug info');
  });
});
