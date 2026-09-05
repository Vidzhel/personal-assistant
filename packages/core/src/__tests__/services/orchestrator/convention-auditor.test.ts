import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditConventions } from '../../../services/orchestrator/convention-auditor.ts';

let root: string;
let projectsDir: string;
let libraryDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'raven-current-audit-'));
  projectsDir = join(root, 'projects');
  libraryDir = join(root, 'library');
  mkdirSync(join(projectsDir, 'agents/raven'), { recursive: true });
  mkdirSync(join(projectsDir, 'schedules'), { recursive: true });
  mkdirSync(join(libraryDir, 'skills'), { recursive: true });
  writeFileSync(join(libraryDir, 'skills/_index.md'), '# Fixture capabilities');
  mkdirSync(join(libraryDir, 'mcps'), { recursive: true });
  writeFileSync(
    join(projectsDir, 'agents/raven/agent.yaml'),
    'name: raven\ndisplayName: Raven\nisDefault: true\nskills: []\n',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('current definition audit', () => {
  it('validates current YAML and ignores obsolete JSON', async () => {
    writeFileSync(join(projectsDir, 'agents.json'), 'invalid obsolete JSON');
    const report = await auditConventions({ projectsDir, libraryDir });
    expect(report.violations).toEqual([]);
    expect(report.compliantCount).toBe(report.totalChecked);
  });

  it('reports current nested agent, schedule and capability errors', async () => {
    mkdirSync(join(projectsDir, 'nested/agents/broken'), { recursive: true });
    writeFileSync(join(projectsDir, 'nested/context.md'), '# Nested');
    writeFileSync(
      join(projectsDir, 'nested/agents/broken/agent.yaml'),
      'name: broken\ndisplayName: Broken\nskills: [missing]\n',
    );
    writeFileSync(join(projectsDir, 'schedules/broken.yaml'), 'name: broken\ncron: impossible\n');
    writeFileSync(join(libraryDir, 'mcps/broken.json'), '{invalid');
    const report = await auditConventions({ projectsDir, libraryDir, knownSkills: new Set() });
    expect(report.violations.some((v) => v.message.includes('missing'))).toBe(true);
    expect(report.violations.some((v) => v.message.includes('broken.yaml'))).toBe(true);
    expect(report.violations.some((v) => v.resourceType === 'library')).toBe(true);
    expect(report.compliantCount).toBe(0);
  });

  it('reports missing current roots instead of claiming an empty clean audit', async () => {
    rmSync(projectsDir, { recursive: true });
    const report = await auditConventions({ projectsDir, libraryDir });
    expect(report.violations).toEqual([
      expect.objectContaining({
        resourceType: 'project',
        severity: 'error',
        rule: 'readable-definition-root',
      }),
    ]);
  });
  it('reads newly added skills on the next audit without restarting the service', async () => {
    writeFileSync(
      join(projectsDir, 'agents/raven/agent.yaml'),
      'name: raven\ndisplayName: Raven\nisDefault: true\nskills: [new-skill]\n',
    );
    const before = await auditConventions({ projectsDir, libraryDir });
    expect(before.violations.some((v) => v.message.includes('new-skill'))).toBe(true);
    mkdirSync(join(libraryDir, 'skills/new-skill'), { recursive: true });
    writeFileSync(
      join(libraryDir, 'skills/new-skill/config.json'),
      JSON.stringify({
        name: 'new-skill',
        displayName: 'New skill',
        description: 'Newly activated capability',
        mcps: [],
        actions: [],
      }),
    );
    writeFileSync(
      join(libraryDir, 'skills/new-skill/skill.md'),
      'Use this newly activated capability.',
    );
    const after = await auditConventions({ projectsDir, libraryDir });
    expect(after.violations).toEqual([]);
  });
});
