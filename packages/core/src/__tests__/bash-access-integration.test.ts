import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dump as yamlDump } from 'js-yaml';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { validateProjects } from '../project-registry/project-validator.ts';

// Path to actual projects directory
const REAL_PROJECTS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'projects');

describe('bash access integration', () => {
  describe('real project agents', () => {
    let registry: ProjectRegistry;

    beforeEach(async () => {
      registry = new ProjectRegistry();
      await registry.load(REAL_PROJECTS_DIR);
    });

    it('raven agent defaults to no bash access', () => {
      const global = registry.getGlobal();
      const raven = global.agents.find((a) => a.name === 'raven');
      expect(raven).toBeDefined();
      // No bash field means default (none)
      expect(raven!.bash).toBeUndefined();
    });

    it('system-admin agent has scoped bash access', () => {
      const systemProject = registry.findByName('system');
      expect(systemProject).toBeDefined();
      const admin = systemProject!.agents.find((a) => a.name === 'system-admin');
      expect(admin).toBeDefined();
      expect(admin!.bash).toBeDefined();
      expect(admin!.bash!.access).toBe('scoped');
      expect(admin!.bash!.allowedPaths).toContain('data/**');
      expect(admin!.bash!.deniedPaths).toContain('.env');
    });

    it('_evaluator agent has explicit none bash access', () => {
      const global = registry.getGlobal();
      const evaluator = global.agents.find((a) => a.name === '_evaluator');
      expect(evaluator).toBeDefined();
      expect(evaluator!.bash).toBeDefined();
      expect(evaluator!.bash!.access).toBe('none');
    });

    it('project validation passes for all agent bash configs', async () => {
      const errors = await validateProjects(REAL_PROJECTS_DIR);
      expect(errors).toEqual([]);
    });
  });

  describe('validator bash checks', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'raven-bash-val-'));
      writeFileSync(join(tmpDir, 'context.md'), 'Global');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function mkAgent(relPath: string, agent: Record<string, unknown>): void {
      const base = relPath ? join(tmpDir, relPath) : tmpDir;
      mkdirSync(join(base, 'agents'), { recursive: true });
      if (relPath) {
        writeFileSync(join(base, 'context.md'), `${relPath} context`);
      }
      writeFileSync(join(base, 'agents', `${agent.name}.yaml`), yamlDump(agent));
    }

    it('rejects full bash access in non-global project', async () => {
      mkAgent('myproject', {
        name: 'risky-agent',
        displayName: 'Risky Agent',
        description: 'Wants full bash in wrong scope',
        bash: { access: 'full' },
      });

      const errors = await validateProjects(tmpDir);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('bash.access: full not allowed');
      expect(errors[0]).toContain('risky-agent');
    });

    it('allows full bash access for global agents', async () => {
      mkAgent('', {
        name: 'global-admin',
        displayName: 'Global Admin',
        description: 'Full bash at global scope',
        bash: { access: 'full' },
      });

      const errors = await validateProjects(tmpDir);
      expect(errors).toEqual([]);
    });

    it('allows full bash access for system project agents', async () => {
      mkAgent('system', {
        name: 'sys-agent',
        displayName: 'System Agent',
        description: 'Full bash at system scope',
        bash: { access: 'full' },
      });

      const errors = await validateProjects(tmpDir);
      expect(errors).toEqual([]);
    });

    it('flags path traversal in allowedPaths', async () => {
      mkAgent('', {
        name: 'traverse-agent',
        displayName: 'Traverse Agent',
        description: 'Has path traversal',
        bash: {
          access: 'scoped',
          allowedPaths: ['data/**', '../../etc/passwd'],
        },
      });

      const errors = await validateProjects(tmpDir);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('..');
      expect(errors[0]).toContain('allowedPaths');
    });

    it('flags path traversal in deniedPaths', async () => {
      mkAgent('', {
        name: 'deny-traverse-agent',
        displayName: 'Deny Traverse',
        description: 'Has path traversal in denied',
        bash: {
          access: 'scoped',
          deniedPaths: ['../../../secrets'],
        },
      });

      const errors = await validateProjects(tmpDir);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('..');
      expect(errors[0]).toContain('deniedPaths');
    });

    it('accepts valid scoped bash config without issues', async () => {
      mkAgent('', {
        name: 'good-agent',
        displayName: 'Good Agent',
        description: 'Properly configured scoped bash',
        bash: {
          access: 'scoped',
          allowedPaths: ['data/**', 'config/**'],
          deniedPaths: ['.env', '.git/**'],
        },
      });

      const errors = await validateProjects(tmpDir);
      expect(errors).toEqual([]);
    });
  });
});
