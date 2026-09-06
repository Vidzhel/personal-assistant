import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { TemplateRegistry } from '../template-engine/template-registry.ts';

const PROJECTS_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'projects');

describe('template integration', () => {
  it('loads real templates from projects/', async () => {
    const reg = new TemplateRegistry();
    await reg.load(PROJECTS_DIR);
    const all = reg.getAllTemplates();
    expect(all.length).toBeGreaterThan(0);
  });

  it('finds morning-briefing template', async () => {
    const reg = new TemplateRegistry();
    await reg.load(PROJECTS_DIR);
    const tmpl = reg.getTemplate('morning-briefing');
    expect(tmpl).toBeDefined();
    expect(tmpl!.tasks.length).toBeGreaterThan(0);
    const taskStep = tmpl!.tasks.find((task) => task.id === 'fetch-tasks');
    expect(taskStep?.type).toBe('agent');
    if (taskStep?.type === 'agent') {
      expect(taskStep.prompt).toContain('list_projects');
      expect(taskStep.prompt).toContain('get_project_with_undone_tasks');
      expect(taskStep.prompt).toContain('undated');
      expect(taskStep.prompt).toContain('partial results');
    }
  });

  it('instantiates research template with params', async () => {
    const reg = new TemplateRegistry();
    await reg.load(PROJECTS_DIR);
    const tmpl = reg.getTemplate('research');
    expect(tmpl).toBeDefined();

    const { instantiateTemplate } = await import('../template-engine/template-instantiator.ts');
    const result = instantiateTemplate(tmpl!, { topic: 'quantum computing' });
    expect(result.errors).toEqual([]);
    expect(result.nodes.length).toBeGreaterThan(0);
    // Check that {{ topic }} was resolved
    const agentNode = result.nodes.find((n) => n.type === 'agent');
    expect(agentNode).toBeDefined();
    if (agentNode?.type === 'agent') {
      expect(agentNode.prompt).toContain('quantum computing');
    }
  });

  it('marks system maintenance as an explicit summary-only workflow', async () => {
    const reg = new TemplateRegistry();
    await reg.load(PROJECTS_DIR);
    const tmpl = reg.getTemplate('system-maintenance');
    expect(tmpl).toBeDefined();

    const { instantiateTemplate } = await import('../template-engine/template-instantiator.ts');
    const result = instantiateTemplate(tmpl!, {});
    expect(result.errors).toEqual([]);
    const node = result.nodes.find((candidate) => candidate.id === 'run-maintenance');
    expect(node?.type).toBe('agent');
    if (node?.type === 'agent') expect(node.validation?.requireArtifacts).toBe(false);
  });

  it('validates all templates pass project validation', async () => {
    const { validateProjects } = await import('../project-registry/project-validator.ts');
    const result = await validateProjects(PROJECTS_DIR);
    expect(result.errors).toEqual([]);
  });
});
