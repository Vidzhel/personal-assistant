import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { validateProjects } from '../project-registry/project-validator.ts';

const PROJECTS_DIR = resolve(import.meta.dirname!, '..', '..', '..', '..', 'projects');

describe('project integration', () => {
  it('loads the real projects directory', async () => {
    const reg = new ProjectRegistry();
    await reg.load(PROJECTS_DIR);
    expect(reg.listProjects().length).toBeGreaterThan(0);
  });

  it('validates the real project structure', async () => {
    const errors = await validateProjects(PROJECTS_DIR);
    expect(errors).toEqual([]);
  });

  it('finds default agent in global scope', async () => {
    const reg = new ProjectRegistry();
    await reg.load(PROJECTS_DIR);
    const global = reg.getGlobal();
    expect(global.agents.some((a) => a.name === 'raven')).toBe(true);
  });

  it('identifies system as meta-project', async () => {
    const reg = new ProjectRegistry();
    await reg.load(PROJECTS_DIR);
    const sys = reg.getProject('system');
    expect(sys).toBeDefined();
    expect(sys!.isMeta).toBe(true);
  });

  it('resolves context chain for system project', async () => {
    const reg = new ProjectRegistry();
    await reg.load(PROJECTS_DIR);
    const resolved = reg.resolveProjectContext('system');
    expect(resolved.contextChain.length).toBeGreaterThanOrEqual(2); // global + system
  });
});
