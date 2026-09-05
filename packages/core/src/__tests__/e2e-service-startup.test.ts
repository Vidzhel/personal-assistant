import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { RavenTask } from '@raven/shared';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';
import type * as ServiceRegistryModule from '../services/registry.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

// Run the real task services with fake agent execution, without enabling any
// account-connected watcher, MCP executable or credential environment variable.
vi.mock('../services/registry.ts', async (importOriginal) => {
  const original = await importOriginal<typeof ServiceRegistryModule>();
  return {
    ...original,
    SERVICE_DEFINITIONS: original.SERVICE_DEFINITIONS.filter((definition) =>
      ['autonomous-manager', 'ticktick-sync'].includes(definition.name),
    ).map((definition) => ({ ...definition, requiresEnv: [] })),
  };
});

describe('task services receive ready dependencies at Raven startup', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
  });

  async function request(path: string, method = 'GET'): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(raven!.port)}/api${path}`, { method });
  }

  it('executes both jobs and stores remote tasks in system YAML without duplicate imports', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-service-startup-'));
    const paths = createRavenTestFixture(root);
    const skillPath = join(paths.libraryDir, 'skills', 'ticktick');
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(
      join(skillPath, 'config.json'),
      JSON.stringify({
        name: 'ticktick',
        displayName: 'TickTick fixture',
        description: 'No external MCP',
        mcps: [],
        actions: [
          {
            name: 'ticktick:get-tasks',
            description: 'Fixture fetch',
            defaultTier: 'green',
            reversible: true,
          },
        ],
      }),
    );
    writeFileSync(join(skillPath, 'skill.md'), 'Return only fake task records.');
    mkdirSync(join(paths.projectsDir, 'schedules'), { recursive: true });
    for (const name of ['ticktick-task-sync', 'autonomous-task-management']) {
      writeFileSync(
        join(paths.projectsDir, 'schedules', `${name}.yaml`),
        stringify({
          name,
          cron: '0 0 1 1 *',
          timezone: 'UTC',
          enabled: false,
          run: { kind: 'job', ref: name },
        }),
      );
    }
    const calls: string[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options.prompt);
      const tasks = options.prompt.includes('Fetch all TickTick tasks for sync')
        ? [
            {
              id: 'external-1',
              projectId: 'ticktick-only-project',
              title: 'Imported task',
              status: 0,
            },
          ]
        : [];
      return { result: JSON.stringify(tasks), success: true, errors: [], estimatedCostUsd: 0 };
    };
    raven = await createRaven(buildTestConfig(), {
      ...paths,
      agentBackend: backend,
      apiHost: '127.0.0.1',
    });
    await raven.start();
    for (const name of ['ticktick-task-sync', 'ticktick-task-sync', 'autonomous-task-management']) {
      expect((await request(`/schedules/${name}/trigger`, 'POST')).ok).toBe(true);
    }
    expect(calls).toHaveLength(3);
    const imported = (await (await request('/tasks?source=ticktick')).json()) as RavenTask[];
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ externalId: 'external-1', title: 'Imported task' });
    expect(imported[0].projectId).toBeUndefined();
    const taskPath = join(paths.projectsDir, 'system', 'tasks', 'board', `${imported[0].id}.yaml`);
    expect(parse(readFileSync(taskPath, 'utf8'))).toMatchObject({ externalId: 'external-1' });
    expect(raven.db.all<{ status: string }>('SELECT status FROM schedule_fires')).toEqual([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'completed' },
    ]);
  });
});
