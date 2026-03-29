import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { stringify as yamlStringify } from 'yaml';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TemplateRegistry } from '../template-engine/template-registry.ts';

let tmpDir: string;
let registry: TemplateRegistry;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'raven-tmpl-reg-'));
  registry = new TemplateRegistry();
  // Create root context.md so it's treated as a project root
  writeFileSync(join(tmpDir, 'context.md'), 'Global context');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'default-template',
    displayName: 'Default Template',
    tasks: [
      {
        id: 'task-1',
        type: 'agent',
        title: 'Do something',
        prompt: 'Do the thing',
      },
    ],
    ...overrides,
  };
}

function writeTemplate(dir: string, template: Record<string, unknown>): void {
  const templatesDir = join(dir, 'templates');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, `${template.name}.yaml`), yamlStringify(template));
}

function mkProject(relPath: string, contextMd = 'Project context'): string {
  const dir = join(tmpDir, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.md'), contextMd);
  return dir;
}

describe('TemplateRegistry', () => {
  it('loads templates from global directory', async () => {
    writeTemplate(tmpDir, makeTemplate({ name: 'global-task' }));

    await registry.load(tmpDir);

    const templates = registry.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('global-task');
  });

  it('loads templates from project-scoped directory', async () => {
    const projDir = mkProject('uni');
    writeTemplate(projDir, makeTemplate({ name: 'study-plan' }));

    await registry.load(tmpDir);

    const tmpl = registry.getTemplate('study-plan', 'uni');
    expect(tmpl).toBeDefined();
    expect(tmpl!.name).toBe('study-plan');
  });

  it('deeper template overrides same-name parent template', async () => {
    writeTemplate(
      tmpDir,
      makeTemplate({
        name: 'research',
        displayName: 'Global Research',
      }),
    );
    const projDir = mkProject('uni');
    writeTemplate(
      projDir,
      makeTemplate({
        name: 'research',
        displayName: 'Uni Research',
      }),
    );

    await registry.load(tmpDir);

    const global = registry.getTemplate('research');
    expect(global!.displayName).toBe('Global Research');

    const scoped = registry.getTemplate('research', 'uni');
    expect(scoped!.displayName).toBe('Uni Research');
  });

  it('listTemplates() with no projectId returns global templates', async () => {
    writeTemplate(tmpDir, makeTemplate({ name: 'global-one' }));
    writeTemplate(tmpDir, makeTemplate({ name: 'global-two' }));
    // Overwrite the second since both go to same dir - use different file
    const templatesDir = join(tmpDir, 'templates');
    writeFileSync(
      join(templatesDir, 'global-two.yaml'),
      yamlStringify(makeTemplate({ name: 'global-two', displayName: 'Two' })),
    );

    const projDir = mkProject('uni');
    writeTemplate(projDir, makeTemplate({ name: 'project-only' }));

    await registry.load(tmpDir);

    const globals = registry.listTemplates();
    const names = globals.map((t) => t.name);
    expect(names).toContain('global-one');
    expect(names).toContain('global-two');
    expect(names).not.toContain('project-only');
  });

  it('listTemplates(projectId) returns inherited + own templates', async () => {
    writeTemplate(tmpDir, makeTemplate({ name: 'global-tmpl' }));
    const projDir = mkProject('uni');
    writeTemplate(projDir, makeTemplate({ name: 'uni-tmpl' }));

    await registry.load(tmpDir);

    const templates = registry.listTemplates('uni');
    const names = templates.map((t) => t.name);
    expect(names).toContain('global-tmpl');
    expect(names).toContain('uni-tmpl');
  });

  it('getTemplate(name) resolves from nearest scope', async () => {
    writeTemplate(
      tmpDir,
      makeTemplate({
        name: 'shared',
        displayName: 'Global Shared',
      }),
    );
    const uniDir = mkProject('uni');
    writeTemplate(
      uniDir,
      makeTemplate({
        name: 'shared',
        displayName: 'Uni Shared',
      }),
    );
    const calcDir = mkProject('uni/calculus');
    writeTemplate(
      calcDir,
      makeTemplate({
        name: 'shared',
        displayName: 'Calculus Shared',
      }),
    );

    await registry.load(tmpDir);

    expect(registry.getTemplate('shared', 'uni/calculus')!.displayName).toBe('Calculus Shared');
    expect(registry.getTemplate('shared', 'uni')!.displayName).toBe('Uni Shared');
    expect(registry.getTemplate('shared')!.displayName).toBe('Global Shared');
  });

  it('handles empty template directories', async () => {
    mkdirSync(join(tmpDir, 'templates'), { recursive: true });
    const projDir = mkProject('empty-proj');
    mkdirSync(join(projDir, 'templates'), { recursive: true });

    await registry.load(tmpDir);

    expect(registry.listTemplates()).toHaveLength(0);
    expect(registry.listTemplates('empty-proj')).toHaveLength(0);
  });

  it('getAllTemplates returns templates from all scopes', async () => {
    writeTemplate(tmpDir, makeTemplate({ name: 'global-one' }));
    const projDir = mkProject('uni');
    writeTemplate(projDir, makeTemplate({ name: 'uni-one' }));

    await registry.load(tmpDir);

    const all = registry.getAllTemplates();
    const names = all.map((t) => t.name);
    expect(names).toContain('global-one');
    expect(names).toContain('uni-one');
  });
});
