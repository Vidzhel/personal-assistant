import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { SERVICE_DEFINITIONS } from '../../../services/registry.ts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..');

describe('official TickTick consumer registration', () => {
  it('gates the retained manual manager on the dedicated MCP token', () => {
    const manager = SERVICE_DEFINITIONS.find(
      (definition) => definition.name === 'autonomous-manager',
    );
    expect(manager?.requiresEnv).toEqual(['TICKTICK_MCP_TOKEN']);
    expect(SERVICE_DEFINITIONS.some((definition) => definition.name === 'ticktick-sync')).toBe(
      false,
    );
  });

  it('ships autonomous reorganization disabled', () => {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, 'projects/schedules/autonomous-task-management.yaml'),
      'utf8',
    );
    expect(parse(source)).toMatchObject({
      enabled: false,
      run: { kind: 'job', ref: 'autonomous-task-management' },
    });
  });

  it('requires the digest skill to disclose incomplete TickTick coverage', () => {
    const source = readFileSync(
      resolve(REPOSITORY_ROOT, 'library/skills/productivity/briefing/daily-digest/skill.md'),
      'utf8',
    );
    expect(source).toContain('get_project_with_undone_tasks');
    expect(source).toContain('high-priority undated');
    expect(source).toContain('Never claim the task list is account-complete');
  });
});
