import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentTaskCompleteEvent, AgentTaskRequestEvent } from '@raven/shared';
import type { BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { createRavenTestFixture, buildTestConfig } from './fixtures/raven-fixture.ts';

function alphaContext(body: string, instructions: string): string {
  return `---\nravenProject:\n  version: 1\n  id: alpha\n  systemPrompt: ${instructions}\n---\n${body}\n`;
}

describe('current workspace context through runtime dispatch', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;
  afterEach(async () => {
    await raven?.stop();
    raven = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('refreshes chat instructions, scopes execution context and links repository indexes without ingestion', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-current-workspace-context-'));
    const fixture = createRavenTestFixture(root);
    const repo = join(root, 'attached repository');
    mkdirSync(repo);
    writeFileSync(join(repo, 'AGENTS.md'), 'PRIVATE_REPOSITORY_BODY_DO_NOT_INGEST');
    writeFileSync(join(fixture.projectsDir, 'context.md'), '# Shared ancestor overview');
    for (const name of ['alpha', 'beta']) mkdirSync(join(fixture.projectsDir, name));
    const alpha = join(fixture.projectsDir, 'alpha/context.md');
    writeFileSync(alpha, alphaContext('Outdated overview', 'Outdated configured instructions'));
    writeFileSync(join(fixture.projectsDir, 'beta/context.md'), '# Private beta overview');
    writeFileSync(
      join(fixture.projectsDir, 'alpha/project.yaml'),
      JSON.stringify({
        version: 1,
        execution: { mode: 'full', sourceId: 'repository' },
        sources: [
          {
            id: 'repository',
            uri: repo,
            label: 'Research source',
            sourceType: 'folder',
            contextFiles: ['AGENTS.md'],
            createdAt: '2026-09-06T00:00:00Z',
            updatedAt: '2026-09-06T00:00:00Z',
          },
        ],
      }),
    );
    const calls: BackendOptions[] = [];
    const completions: AgentTaskCompleteEvent[] = [];
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      skipSuites: true,
      agentBackend: async (options) => {
        calls.push(options);
        return {
          sessionId: 'sdk-current-context',
          result: 'Done',
          success: true,
          errors: [],
          estimatedCostUsd: 0,
        };
      },
    });
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) =>
      completions.push(event),
    );
    await raven.start();
    const chat = async () => {
      const response = await fetch(`http://localhost:${raven!.port}/api/projects/alpha/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Use current project instructions' }),
      });
      expect(response.status).toBe(200);
    };
    // Manual edits deliberately do not reload the registry or SQL cache.
    writeFileSync(alpha, alphaContext('Current alpha overview', 'Current configured instructions'));
    await chat();
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0].payload.success).toBe(true);
    expect(calls[0].cwd).toBe(repo);
    for (const text of [
      'Shared ancestor overview',
      'Current alpha overview',
      'Current configured instructions',
      'Research source',
      'AGENTS.md',
    ]) {
      expect(calls[0].systemPrompt).toContain(text);
    }
    for (const text of ['Outdated', 'Private beta', 'PRIVATE_REPOSITORY_BODY_DO_NOT_INGEST']) {
      expect(calls[0].systemPrompt).not.toContain(text);
    }
    raven.eventBus.emit({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'test',
      type: 'agent:task:request',
      payload: {
        taskId: 'context-execution',
        projectId: 'beta',
        namedAgentId: 'raven',
        skillName: 'worker',
        prompt: 'Execution work',
        priority: 'normal',
        mcpServers: {},
        agentDefinitions: {
          writer: { description: 'Write', prompt: 'Skill writer instructions', tools: ['Read'] },
        },
      },
    } satisfies AgentTaskRequestEvent);
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(completions[1].payload.success).toBe(true);
    expect(calls[1].systemPrompt).toContain('Shared ancestor overview');
    expect(calls[1].systemPrompt).toContain('Private beta overview');
    expect(calls[1].systemPrompt).not.toContain('Current alpha overview');
    expect(calls[1].systemPrompt).not.toContain('Research source');
    expect(calls[1].agents.writer.prompt).toContain('Private beta overview');
    expect(calls[1].agents.writer.prompt).toContain('Skill writer instructions');
    expect(calls[1].agents.writer.prompt).not.toContain('Current alpha overview');
    expect(calls[1].agents.writer.tools).toEqual(['Read']);
    writeFileSync(alpha, alphaContext('Newest alpha overview', 'Newest configured instructions'));
    await chat();
    await vi.waitFor(() => expect(completions).toHaveLength(3));
    expect(calls[2].systemPrompt).toContain('Newest configured instructions');
    expect(calls[2].resume).toBeUndefined();
    await chat();
    await vi.waitFor(() => expect(completions).toHaveLength(4));
    expect(calls[3].resume).toBe('sdk-current-context');
  }, 15000);
});
