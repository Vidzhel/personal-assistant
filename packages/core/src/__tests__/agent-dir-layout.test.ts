import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanProjects } from '../project-registry/project-scanner.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import type { AgentYaml } from '@raven/shared';

const FLAT_AGENT = `name: flat-agent
displayName: Flat Agent
description: Lives as a flat yaml file
skills: []
model: sonnet
maxTurns: 20
`;

const DIR_AGENT = `name: dir-agent
displayName: Dir Agent
description: Lives in a directory
skills: []
model: sonnet
maxTurns: 20
`;

describe('directory-per-agent layout', () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-agentdir-'));
    writeFileSync(join(projectsDir, 'context.md'), '# Global\n');
    mkdirSync(join(projectsDir, 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  describe('project-scanner', () => {
    it('loads agents from both flat files and <name>/agent.yaml directories', async () => {
      writeFileSync(join(projectsDir, 'agents', 'flat-agent.yaml'), FLAT_AGENT);
      mkdirSync(join(projectsDir, 'agents', 'dir-agent'), { recursive: true });
      writeFileSync(join(projectsDir, 'agents', 'dir-agent', 'agent.yaml'), DIR_AGENT);

      const index = await scanProjects(projectsDir);
      const global = index.projects.get('_global');
      const names = (global?.agents ?? []).map((a) => a.name).sort();

      expect(names).toEqual(['dir-agent', 'flat-agent']);
    });

    it('ignores agent directories without agent.yaml (e.g. only memory/)', async () => {
      mkdirSync(join(projectsDir, 'agents', 'broken-agent', 'memory'), { recursive: true });

      const index = await scanProjects(projectsDir);
      const global = index.projects.get('_global');

      expect(global?.agents ?? []).toEqual([]);
    });
  });

  describe('agent-yaml-store', () => {
    const store = createAgentYamlStore();
    const agent: AgentYaml = {
      name: 'new-agent',
      displayName: 'New Agent',
      description: 'Created by store',
      isDefault: false,
      skills: [],
      model: 'sonnet',
      maxTurns: 20,
    } as AgentYaml;

    it('creates agents in the directory layout', async () => {
      await store.createAgent(projectsDir, agent);
      expect(existsSync(join(projectsDir, 'agents', 'new-agent', 'agent.yaml'))).toBe(true);
    });

    it('updates an agent stored in the directory layout', async () => {
      await store.createAgent(projectsDir, agent);
      const updated = await store.updateAgent(projectsDir, 'new-agent', {
        description: 'Updated',
      });
      expect(updated.description).toBe('Updated');
      const content = readFileSync(join(projectsDir, 'agents', 'new-agent', 'agent.yaml'), 'utf-8');
      expect(content).toContain('Updated');
    });

    it('updates a legacy flat-file agent in place', async () => {
      writeFileSync(join(projectsDir, 'agents', 'flat-agent.yaml'), FLAT_AGENT);
      const updated = await store.updateAgent(projectsDir, 'flat-agent', {
        description: 'Flat updated',
      });
      expect(updated.description).toBe('Flat updated');
      expect(existsSync(join(projectsDir, 'agents', 'flat-agent.yaml'))).toBe(true);
    });

    it('deletes agents in either layout', async () => {
      await store.createAgent(projectsDir, agent);
      writeFileSync(join(projectsDir, 'agents', 'flat-agent.yaml'), FLAT_AGENT);

      await store.deleteAgent(projectsDir, 'new-agent');
      await store.deleteAgent(projectsDir, 'flat-agent');

      expect(existsSync(join(projectsDir, 'agents', 'new-agent'))).toBe(false);
      expect(existsSync(join(projectsDir, 'agents', 'flat-agent.yaml'))).toBe(false);
    });

    it('accepts an empty description (default)', async () => {
      await store.createAgent(projectsDir, {
        ...agent,
        name: 'no-desc',
        description: '',
      } as AgentYaml);
      expect(existsSync(join(projectsDir, 'agents', 'no-desc', 'agent.yaml'))).toBe(true);
    });
  });
});
