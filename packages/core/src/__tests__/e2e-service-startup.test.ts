import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { RavenTask } from '@raven/shared';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';
import type * as ServiceRegistryModule from '../services/registry.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

vi.mock('../services/registry.ts', async (importOriginal) => {
  const original = await importOriginal<typeof ServiceRegistryModule>();
  return {
    ...original,
    SERVICE_DEFINITIONS: original.SERVICE_DEFINITIONS.filter(
      (definition) => definition.name === 'autonomous-manager',
    ).map((definition) => ({ ...definition, requiresEnv: [] })),
  };
});

const OFFICIAL_READ_ACTIONS = [
  'ticktick:list-projects',
  'ticktick:get-project-with-undone-tasks',
  'ticktick:list-undone-tasks-by-date',
  'ticktick:filter-tasks',
];

describe('task services receive ready dependencies at Raven startup', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('queries the official workload without mirroring TickTick into Raven board YAML', async () => {
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
        actions: OFFICIAL_READ_ACTIONS.map((name) => ({
          name,
          description: 'Fixture official read',
          defaultTier: 'green',
          reversible: true,
        })),
      }),
    );
    writeFileSync(join(skillPath, 'skill.md'), 'Return only the requested fixture records.');
    mkdirSync(join(paths.projectsDir, 'schedules'), { recursive: true });
    writeFileSync(
      join(paths.projectsDir, 'schedules', 'autonomous-task-management.yaml'),
      stringify({
        name: 'autonomous-task-management',
        cron: '0 0 1 1 *',
        timezone: 'UTC',
        enabled: false,
        run: { kind: 'job', ref: 'autonomous-task-management' },
      }),
    );
    const calls: string[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options.prompt);
      if (options.prompt.includes('Call list_projects and exhaust pagination')) {
        return result({
          projects: [{ id: 'p1', name: 'Work' }],
          complete: true,
          nextCursor: null,
        });
      }
      if (options.prompt.includes('Call get_project_with_undone_tasks')) {
        return result({
          tasks: [{ id: 'external-1', projectId: 'p1', title: 'Authoritative task' }],
          complete: true,
          nextCursor: null,
        });
      }
      if (options.prompt.includes('You are analyzing')) return result([]);
      return result({ tasks: [], complete: true, nextCursor: null });
    };
    raven = await createRaven(buildTestConfig(), {
      ...paths,
      agentBackend: backend,
      apiHost: '127.0.0.1',
    });
    await raven.start();

    const trigger = await fetch(
      `http://127.0.0.1:${String(raven.port)}/api/schedules/autonomous-task-management/trigger`,
      { method: 'POST' },
    );
    expect(trigger.ok).toBe(true);
    expect(calls).toHaveLength(7);
    expect(calls.join('\n')).not.toContain('get_all_tasks');
    const board = (await (
      await fetch(`http://127.0.0.1:${String(raven.port)}/api/tasks?source=ticktick`)
    ).json()) as RavenTask[];
    expect(board).toEqual([]);
  });
});

function result(value: unknown): Awaited<ReturnType<AgentBackend>> {
  return {
    result: JSON.stringify(value),
    success: true,
    errors: [],
    estimatedCostUsd: 0,
  };
}
