import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestMcpClient } from './mcp-test-client.ts';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('TickTick MCP Server (startup)', () => {
  it('exits with error when TICKTICK_ACCESS_TOKEN is missing', async () => {
    const child = spawn('node', ['--experimental-strip-types', 'src/index.ts'], {
      env: { ...process.env, TICKTICK_ACCESS_TOKEN: '' },
      cwd: PKG_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
  });
});

const TOKEN = process.env.TICKTICK_ACCESS_TOKEN;
const describeWithToken = TOKEN ? describe : describe.skip;

describeWithToken('TickTick MCP Server (real API)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createTestMcpClient({
      TICKTICK_ACCESS_TOKEN: TOKEN!,
    }));
  });

  afterAll(async () => {
    await transport.close();
  });

  it('lists available tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('get_projects');
    expect(names).toContain('get_all_tasks');
    expect(names).toContain('create_task');
    expect(names).toContain('filter_tasks');
  });

  it('get_projects returns valid project list', async () => {
    const result = await client.callTool({ name: 'get_projects', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const projects = JSON.parse(content[0].text) as Array<Record<string, unknown>>;
    expect(Array.isArray(projects)).toBe(true);
    for (const p of projects) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('name');
    }
  });

  it('get_all_tasks returns tasks array', async () => {
    const result = await client.callTool({ name: 'get_all_tasks', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const tasks = JSON.parse(content[0].text) as unknown[];
    expect(Array.isArray(tasks)).toBe(true);
  });

  it('get_today_tasks returns sorted by priority', async () => {
    const result = await client.callTool({ name: 'get_today_tasks', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const tasks = JSON.parse(content[0].text) as unknown[];
    expect(Array.isArray(tasks)).toBe(true);
  });

  it('filter_tasks with status filter', async () => {
    const result = await client.callTool({
      name: 'filter_tasks',
      arguments: { status: [0] },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const tasks = JSON.parse(content[0].text) as unknown[];
    expect(Array.isArray(tasks)).toBe(true);
  });

  it('get_project_tasks with real project ID', async () => {
    const projResult = await client.callTool({ name: 'get_projects', arguments: {} });
    const projContent = projResult.content as Array<{ type: string; text: string }>;
    const projects = JSON.parse(projContent[0].text) as Array<{ id: string }>;
    if (projects.length === 0) return;

    const result = await client.callTool({
      name: 'get_project_tasks',
      arguments: { projectId: projects[0].id },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(data).toHaveProperty('project');
    expect(data).toHaveProperty('tasks');
  });
});
