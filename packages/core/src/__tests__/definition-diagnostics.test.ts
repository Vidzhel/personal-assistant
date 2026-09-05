import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProjects } from '../project-registry/project-scanner.ts';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { loadLibrary } from '../capability-library/library-loader.ts';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';
import * as libraryLoader from '../capability-library/library-loader.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function project(rootDir: string, path: string, context: string): void {
  const dir = join(rootDir, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.md'), context);
}

describe('definition diagnostics', () => {
  it('keeps valid project siblings and records malformed child paths', async () => {
    const dir = root('raven-definition-projects-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    project(dir, 'broken', '---\nravenProject: [bad\n---\nBody');
    project(dir, 'healthy', 'Healthy');

    const index = await scanProjects(dir);

    expect(index.projects.has('healthy')).toBe(true);
    expect(index.projects.has('broken')).toBe(false);
    expect(index.invalidProjectPaths).toEqual(['broken']);
    expect(index.diagnostics).toEqual([
      expect.objectContaining({
        source: 'project',
        path: 'broken/context.md',
        code: 'invalid-project-context',
        severity: 'error',
      }),
    ]);
  });

  it('skips invalid schedule timing while retaining valid schedules and reports bindings', async () => {
    const dir = root('raven-definition-schedules-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    const schedules = join(dir, 'schedules');
    const agents = join(dir, 'agents');
    mkdirSync(schedules);
    mkdirSync(agents);
    writeFileSync(
      join(schedules, 'bad.yaml'),
      'name: bad\ncron: nope\ntimezone: UTC\nenabled: true\nrun: {kind: job, ref: x}\n',
    );
    writeFileSync(
      join(schedules, 'good.yaml'),
      'name: good\ncron: "0 9 * * *"\ntimezone: UTC\nenabled: true\nrun: {kind: job, ref: x}\n',
    );
    writeFileSync(
      join(agents, 'agent.yaml'),
      'name: helper\ndisplayName: Helper\ndescription: Helper\nskills: [missing]\n',
    );

    const index = await scanProjects(dir, { knownSkills: new Set(['present']) });
    const global = index.projects.get('_global');

    expect(global?.schedules.map((schedule) => schedule.name)).toEqual(['good']);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'schedules/bad.yaml', code: 'invalid-schedule-timing' }),
        expect.objectContaining({ path: 'agents/agent.yaml', code: 'unknown-skill-reference' }),
      ]),
    );
  });

  it('replaces diagnostics on reload and hides paths supplied by runtime recovery', async () => {
    const dir = root('raven-definition-reload-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    project(dir, 'broken', '---\nravenProject: [bad\n---\nBody');
    project(dir, 'pending', '---\nravenProject:\n  version: 1\n  skills: [missing]\n---\nPending');
    project(dir, 'pending/child', 'Pending child');
    const unavailable = ['pending'];
    const knownSkills = new Set<string>();
    const registry = new ProjectRegistry({
      getUnavailableProjectPaths: () => unavailable,
      getKnownSkills: () => knownSkills,
    });

    await registry.load(dir);
    expect(registry.getDefinitionDiagnostics()).toHaveLength(2);
    expect(registry.getDefinitionDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'broken/context.md' }),
        expect.objectContaining({ path: 'pending/context.md', code: 'unknown-skill-reference' }),
      ]),
    );
    expect(registry.getProject('pending')).toBeUndefined();
    expect(registry.listProjects().map((project) => project.id)).not.toContain('pending');
    expect(registry.listProjects().map((project) => project.id)).not.toContain('pending/child');
    expect(registry.getProjectChildren('pending')).toEqual([]);
    expect(registry.getInvalidProjectPaths()).toEqual(
      expect.arrayContaining(['broken', 'pending']),
    );

    writeFileSync(join(dir, 'broken', 'context.md'), 'Repaired');
    knownSkills.add('missing');
    unavailable.splice(0);
    await registry.load(dir);
    expect(registry.getDefinitionDiagnostics()).toEqual([]);
    expect(registry.getProject('broken')).toBeDefined();
    expect(registry.getProject('pending')).toBeDefined();
  });

  it('keeps the global project usable while a conservative root block hides ordinary nodes', async () => {
    const dir = root('raven-definition-root-block-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    project(dir, 'ordinary', 'Ordinary');
    const registry = new ProjectRegistry({ getUnavailableProjectPaths: () => ['.'] });

    await registry.load(dir);

    expect(registry.getGlobal()).toBeDefined();
    expect(registry.listProjects()).toEqual([]);
    expect(registry.getProject('ordinary')).toBeUndefined();
    expect(() => registry.resolveProjectContext('ordinary')).toThrow('unavailable');
  });

  it('fails closed when the projects root disappears during reload', async () => {
    const dir = root('raven-definition-missing-root-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    project(dir, 'healthy', 'Healthy');
    const registry = new ProjectRegistry();
    await registry.load(dir);

    rmSync(dir, { recursive: true, force: true });
    await expect(registry.load(dir)).rejects.toThrow();
    expect(registry.getProject('healthy')).toBeDefined();
    expect(registry.getDefinitionDiagnostics()).toEqual([
      expect.objectContaining({ code: 'project-root-unavailable', severity: 'error' }),
    ]);
    expect(() => registry.assertHealthy()).toThrow();
  });

  it('diagnoses duplicate metadata identities before publishing ambiguous projects', async () => {
    const dir = root('raven-definition-duplicate-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    project(dir, 'first', '---\nravenProject:\n  version: 1\n  id: same\n---\nFirst');
    project(dir, 'second', '---\nravenProject:\n  version: 1\n  id: same\n---\nSecond');
    const registry = new ProjectRegistry();

    await registry.load(dir);

    expect(registry.listProjects()).toEqual([]);
    expect(registry.getInvalidProjectPaths()).toEqual(expect.arrayContaining(['first', 'second']));
    expect(registry.getDefinitionDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'first/context.md', code: 'duplicate-project-identity' }),
        expect.objectContaining({ path: 'second/context.md', code: 'duplicate-project-identity' }),
      ]),
    );
  });

  it('keeps nested system paths ordinary and rejects explicit meta collisions', async () => {
    const dir = root('raven-definition-system-identity-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    project(dir, 'course', 'Course');
    project(dir, 'course/system', 'Nested system');
    project(dir, 'collision', '---\nravenProject:\n  version: 1\n  id: meta\n---\nCollision');
    const registry = new ProjectRegistry();

    await registry.load(dir);

    expect(registry.getProject('course/system')).toBeDefined();
    expect(registry.getProject('collision')).toBeUndefined();
    expect(registry.getDefinitionDiagnostics()).toEqual([
      expect.objectContaining({ path: 'collision/context.md', code: 'system-identity-conflict' }),
    ]);
  });

  it('reports malformed and missing library bindings without dropping valid skills', async () => {
    const dir = root('raven-definition-library-');
    mkdirSync(join(dir, 'mcps'));
    mkdirSync(join(dir, 'skills', 'domain', 'good'), { recursive: true });
    mkdirSync(join(dir, 'skills', 'domain', 'bad'), { recursive: true });
    writeFileSync(join(dir, 'mcps', 'broken.json'), '{broken');
    writeFileSync(
      join(dir, 'mcps', 'fixed.json'),
      JSON.stringify({ name: 'fixed', displayName: 'Fixed', command: 'node', args: [] }),
    );
    writeFileSync(
      join(dir, 'mcps', 'duplicate.json'),
      JSON.stringify({ name: 'fixed', displayName: 'Duplicate', command: 'node', args: [] }),
    );
    writeFileSync(
      join(dir, 'skills', 'domain', 'good', 'config.json'),
      JSON.stringify({
        name: 'good',
        displayName: 'Good',
        description: 'Good',
        mcps: ['missing-mcp'],
        vendorSkills: ['missing/plugin'],
      }),
    );
    writeFileSync(join(dir, 'skills', 'domain', 'bad', 'config.json'), '{bad');

    const loaded = await loadLibrary(dir);
    expect(loaded.skills.has('good')).toBe(true);
    expect(loaded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'mcp', code: 'invalid-mcp-definition' }),
        expect.objectContaining({ source: 'mcp', code: 'duplicate-mcp-name' }),
        expect.objectContaining({ source: 'skill', code: 'invalid-skill-definition' }),
        expect.objectContaining({ source: 'skill', code: 'unknown-mcp-reference' }),
        expect.objectContaining({ source: 'skill', code: 'unknown-vendor-reference' }),
      ]),
    );

    const library = new CapabilityLibrary();
    await library.load(dir);
    expect(library.getDefinitionDiagnostics().length).toBeGreaterThan(0);

    writeFileSync(
      join(dir, 'mcps', 'broken.json'),
      JSON.stringify({
        name: 'fixed',
        displayName: 'Fixed',
        command: 'node',
        args: [],
      }),
    );
    rmSync(join(dir, 'mcps', 'duplicate.json'));
    rmSync(join(dir, 'mcps', 'fixed.json'));
    writeFileSync(
      join(dir, 'skills', 'domain', 'good', 'config.json'),
      JSON.stringify({ name: 'good', displayName: 'Good', description: 'Good' }),
    );
    writeFileSync(join(dir, 'skills', 'domain', 'good', 'skill.md'), '# Good');
    writeFileSync(
      join(dir, 'skills', 'domain', 'bad', 'config.json'),
      JSON.stringify({ name: 'bad', displayName: 'Bad', description: 'Bad' }),
    );
    writeFileSync(join(dir, 'skills', 'domain', 'bad', 'skill.md'), '# Bad');
    await library.load(dir);
    expect(library.getDefinitionDiagnostics()).toEqual([]);
  });

  it('retains the previous registry index but fails closed after a fatal reload', async () => {
    const dir = root('raven-definition-fatal-reload-');
    writeFileSync(join(dir, 'context.md'), 'Global');
    project(dir, 'healthy', 'Healthy');
    const registry = new ProjectRegistry();
    await registry.load(dir);

    writeFileSync(join(dir, 'context.md'), '---\nravenProject: [broken\n---\nGlobal');
    await expect(registry.load(dir)).rejects.toThrow();
    expect(registry.getProject('healthy')).toBeDefined();
    expect(registry.getDefinitionDiagnostics()).toEqual([
      expect.objectContaining({ code: 'project-root-unavailable', severity: 'error' }),
    ]);
    expect(() => registry.assertHealthy()).toThrow();
  });

  it('retains a capability-load diagnostic after a failed reload', async () => {
    const dir = root('raven-definition-library-reload-');
    const library = new CapabilityLibrary();
    await library.load(dir);
    vi.spyOn(libraryLoader, 'loadLibrary').mockRejectedValueOnce(new Error('library unreadable'));

    await expect(library.load(dir)).rejects.toThrow('library unreadable');
    expect(library.getDefinitionDiagnostics()).toEqual([
      expect.objectContaining({ code: 'library-root-unavailable', severity: 'error' }),
    ]);
  });
});
