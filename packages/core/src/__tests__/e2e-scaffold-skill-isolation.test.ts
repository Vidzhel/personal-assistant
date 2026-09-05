import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTaskCompleteEvent } from '@raven/shared';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

describe('e2e: chat skill scaffolding stays inside the fixture library', () => {
  let root: string;
  let raven: RavenInstance | undefined;
  afterEach(async () => {
    if (raven) await raven.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('writes through the real chat MCP tool and reloads the same isolated library', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-skill-'));
    const fixture = createRavenTestFixture(root);
    raven = await createRaven(buildTestConfig(), {
      ...fixture,
      skipSuites: true,
      agentBackend: async (opts) => {
        const server = (opts.mcpServers.raven as McpSdkServerConfigWithInstance).instance;
        const client = new Client({ name: 'fixture-client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const created = await client.callTool({
            name: 'create_skill',
            arguments: {
              domain: 'testing',
              name: 'fixture-notes',
              displayName: 'Fixture Notes',
              description: 'Summarize test notes',
              skillMd: 'Write a concise summary.',
            },
          });
          expect(created.isError).not.toBe(true);
          const reloaded = await client.callTool({ name: 'reload_registries', arguments: {} });
          expect(reloaded.isError).not.toBe(true);
          opts.onAssistantMessage('Skill created.');
          return { result: 'Skill created.', success: true, errors: [] };
        } finally {
          await client.close();
          await server.close();
        }
      },
    });
    await raven.start();
    const baseUrl = `http://localhost:${raven.port}`;
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fixture skills' }),
    });
    expect(projectRes.status).toBe(200);
    const project = (await projectRes.json()) as { id: string };
    const completed = new Promise<AgentTaskCompleteEvent>((resolve) => {
      raven!.eventBus.once<AgentTaskCompleteEvent>('agent:task:complete', resolve);
    });
    const chatRes = await fetch(`${baseUrl}/api/projects/${project.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Create a notes skill.' }),
    });
    expect(chatRes.status).toBe(200);
    expect((await completed).payload.success).toBe(true);
    const skillsRes = await fetch(`${baseUrl}/api/skills`);
    expect(skillsRes.status).toBe(200);
    expect(await skillsRes.json()).toEqual([
      expect.objectContaining({ name: 'fixture-notes', mcps: [] }),
    ]);
    const skillDir = join(fixture.libraryDir, 'skills', 'testing', 'fixture-notes');
    expect(readFileSync(join(skillDir, 'skill.md'), 'utf8')).toBe('Write a concise summary.\n');
    expect(JSON.parse(readFileSync(join(skillDir, 'config.json'), 'utf8')).name).toBe(
      'fixture-notes',
    );
  }, 10000);
});
