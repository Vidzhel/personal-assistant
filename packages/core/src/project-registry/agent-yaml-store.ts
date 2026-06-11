import { readFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';
const { dump, load: yamlLoad } = yaml;

import { createLogger, AgentYamlSchema } from '@raven/shared';
import type { AgentYaml } from '@raven/shared';

const log = createLogger('agent-yaml-store');

export interface AgentYamlStore {
  createAgent(projectPath: string, agent: AgentYaml): Promise<string>;
  updateAgent(
    projectPath: string,
    agentName: string,
    updates: Partial<AgentYaml>,
  ): Promise<AgentYaml>;
  deleteAgent(projectPath: string, agentName: string): Promise<void>;
  resolveAgentFile(projectPath: string, agentName: string): string;
}

const LINE_WIDTH = 120;

export function createAgentYamlStore(): AgentYamlStore {
  const store: AgentYamlStore = {
    resolveAgentFile(projectPath: string, agentName: string): string {
      const dirLayout = join(projectPath, 'agents', agentName, 'agent.yaml');
      if (existsSync(dirLayout)) return dirLayout;
      return join(projectPath, 'agents', `${agentName}.yaml`);
    },

    async createAgent(projectPath: string, agent: AgentYaml): Promise<string> {
      const validated = AgentYamlSchema.parse(agent);
      const agentDir = join(projectPath, 'agents', validated.name);
      await mkdir(agentDir, { recursive: true });
      const filePath = join(agentDir, 'agent.yaml');
      const content = dump(validated, { lineWidth: LINE_WIDTH });
      await writeFile(filePath, content, 'utf-8');
      log.info(`Created agent YAML: ${validated.name} at ${filePath}`);
      return filePath;
    },

    async updateAgent(
      projectPath: string,
      agentName: string,
      updates: Partial<AgentYaml>,
    ): Promise<AgentYaml> {
      const filePath = store.resolveAgentFile(projectPath, agentName);
      const content = await readFile(filePath, 'utf-8');
      const existing = yamlLoad(content) as Record<string, unknown>;
      const merged = { ...existing, ...updates, name: agentName };
      const validated = AgentYamlSchema.parse(merged);
      const out = dump(validated, { lineWidth: LINE_WIDTH });
      await writeFile(filePath, out, 'utf-8');
      log.info(`Updated agent YAML: ${agentName} at ${filePath}`);
      return validated;
    },

    async deleteAgent(projectPath: string, agentName: string): Promise<void> {
      const dirLayout = join(projectPath, 'agents', agentName);
      if (existsSync(join(dirLayout, 'agent.yaml'))) {
        await rm(dirLayout, { recursive: true });
        log.info(`Deleted agent directory: ${agentName} at ${dirLayout}`);
        return;
      }
      const flatPath = join(projectPath, 'agents', `${agentName}.yaml`);
      await unlink(flatPath);
      log.info(`Deleted agent YAML: ${agentName} at ${flatPath}`);
    },
  };
  return store;
}
