import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentTaskCompleteEvent, AgentTaskRequestEvent } from '@raven/shared';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { resolveSkillCapabilities } from '../agent-registry/agent-resolver.ts';

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('e2e: MCP credential persistence boundary', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    delete process.env['TEST_COMPOSED_MCP_TOKEN'];
    delete process.env['TEST_COMPOSED_MISSING_TOKEN'];
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
  });

  it('redacts materialized authorization from every persisted backend output boundary', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-mcp-secret-'));
    const fixture = createRavenTestFixture(root);
    const secret = 'composed-fake-"secret\\suffix';
    process.env['TEST_COMPOSED_MCP_TOKEN'] = secret;
    const calls: BackendOptions[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options);
      options.onRawMessage?.(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', content: { nested: [`user ${secret}`] } },
              { type: 'thinking', content: secret },
              { [secret]: 'credential appeared as a structured key' },
            ],
          },
        }),
      );
      options.onAssistantMessage(`assistant echoed ${secret}`);
      options.onToolUse?.(
        'fixture-tool',
        JSON.stringify({ authorization: `Bearer ${secret}`, nested: { value: secret } }),
      );
      options.onToolResult?.({
        toolUseId: 'fixture-tool-use',
        output: `tool returned ${secret}`,
        isError: false,
      });
      return { result: `successful result echoed ${secret}`, success: true, errors: [] };
    };
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      apiHost: '127.0.0.1',
      agentBackend: backend,
      modelDiscovery: async () => [
        {
          value: 'sonnet',
          resolvedModel: 'claude-sonnet-4-6',
          displayName: 'Sonnet fixture',
          description: 'Test-only model',
        },
      ],
      skipSuites: true,
    });
    const sessionId = 'secret-safe-session';
    const now = Date.now();
    raven.db.run(
      'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count) VALUES (?, ?, ?, ?, ?, ?)',
      sessionId,
      'meta',
      'idle',
      now,
      now,
      0,
    );
    const completion = new Promise<AgentTaskCompleteEvent>((resolve) => {
      raven!.eventBus.once<AgentTaskCompleteEvent>('agent:task:complete', resolve);
    });
    raven.eventBus.emit({
      id: 'secret-safe-request',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:request',
      payload: {
        taskId: 'secret-safe-task',
        sessionId,
        projectId: 'meta',
        prompt: 'Use the remote fixture',
        skillName: 'remote-fixture',
        priority: 'normal',
        mcpServers: {
          'remote-fixture': {
            type: 'http',
            url: 'https://mcp.example.com',
            headers: { Authorization: 'Bearer ${TEST_COMPOSED_MCP_TOKEN}' },
          },
        },
      },
    } satisfies AgentTaskRequestEvent);
    const completed = await completion;

    expect(calls).toHaveLength(1);
    expect(calls[0].mcpServers['remote-fixture']).toEqual({
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: `Bearer ${secret}` },
      alwaysLoad: true,
    });
    expect(completed.payload.result).toBe('successful result echoed [redacted]');
    const storedPayloads = raven.db.all<{ payload: string }>('SELECT payload FROM events');
    const sessionRows = raven.db.all<Record<string, unknown>>('SELECT * FROM sessions');
    const transcript = readFileSync(
      join(root, 'data', 'sessions', sessionId, 'transcript.jsonl'),
      'utf8',
    );
    const rawOutput = readFileSync(
      join(root, 'data', 'sessions', sessionId, 'raw-output.jsonl'),
      'utf8',
    );
    const runRecord = readFileSync(
      join(fixture.projectsDir, 'system', 'tasks', 'runs', 'secret-safe-task.yaml'),
      'utf8',
    );
    const persisted = [
      JSON.stringify(storedPayloads),
      JSON.stringify(sessionRows),
      transcript,
      rawOutput,
      runRecord,
    ].join('\n');
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain('[redacted]');
    expect(JSON.stringify(storedPayloads)).toContain('${TEST_COMPOSED_MCP_TOKEN}');
  });

  it('does not let a missing HTTP skill inherit an active sibling MCP in nested agents', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-mcp-scope-'));
    const fixture = createRavenTestFixture(root);
    write(join(fixture.libraryDir, 'mcps', 'missing-remote.json'), {
      name: 'missing-remote',
      displayName: 'Missing remote',
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer ${TEST_COMPOSED_MISSING_TOKEN}' },
    });
    write(join(fixture.libraryDir, 'mcps', 'active-mail.json'), {
      name: 'active-mail',
      displayName: 'Active mail',
      command: 'mail-fixture',
      args: [],
    });
    write(join(fixture.libraryDir, 'skills', 'testing', 'missing-skill', 'config.json'), {
      name: 'missing-skill',
      displayName: 'Missing skill',
      description: 'Optional unavailable integration',
      mcps: ['missing-remote'],
      tools: ['mcp__missing-remote__search_task'],
    });
    write(
      join(fixture.libraryDir, 'skills', 'testing', 'missing-skill', 'skill.md'),
      'Missing integration fixture.',
    );
    write(join(fixture.libraryDir, 'skills', 'testing', 'active-skill', 'config.json'), {
      name: 'active-skill',
      displayName: 'Active skill',
      description: 'Available sibling integration',
      mcps: ['active-mail'],
    });
    write(
      join(fixture.libraryDir, 'skills', 'testing', 'active-skill', 'skill.md'),
      'Active integration fixture.',
    );
    const library = new CapabilityLibrary();
    await library.load(fixture.libraryDir);
    const capabilities = resolveSkillCapabilities(library, ['missing-skill', 'active-skill']);
    const backend: AgentBackend = async (options) => {
      expect(options.mcpServers).toHaveProperty('active-mail');
      expect(options.mcpServers).not.toHaveProperty('missing-remote');
      expect(options.agents['missing-skill']).toMatchObject({ tools: [] });
      expect(options.agents['missing-skill'].mcpServers).toBeUndefined();
      expect(options.agents['active-skill']).toMatchObject({
        tools: ['mcp__active-mail__*'],
        mcpServers: ['active-mail'],
      });
      return { result: 'scoped', success: true, errors: [] };
    };
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      agentBackend: backend,
      modelDiscovery: async () => [],
      skipSuites: true,
    });
    const completion = new Promise<AgentTaskCompleteEvent>((resolve) => {
      raven!.eventBus.once<AgentTaskCompleteEvent>('agent:task:complete', resolve);
    });
    raven.eventBus.emit({
      id: 'scope-safe-request',
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:request',
      payload: {
        taskId: 'scope-safe-task',
        prompt: 'Exercise scoped integrations',
        skillName: 'orchestrator',
        priority: 'normal',
        mcpServers: capabilities.mcpServers,
        agentDefinitions: capabilities.agentDefinitions,
      },
    } satisfies AgentTaskRequestEvent);
    expect((await completion).payload.success).toBe(true);
  });
});
