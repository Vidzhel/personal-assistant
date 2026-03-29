import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { dump, load as yamlLoad } from 'js-yaml';

import { createLogger, AgentYamlSchema } from '@raven/shared';
import type { AgentYaml } from '@raven/shared';

const log = createLogger('agent-yaml-store');

export interface AgentYamlStore {
  createAgent(projectPath: string, agent: AgentYaml): Promise<void>;
  updateAgent(
    projectPath: string,
    agentName: string,
    updates: Partial<AgentYaml>,
  ): Promise<AgentYaml>;
  deleteAgent(projectPath: string, agentName: string): Promise<void>;
}

const LINE_WIDTH = 120;

export function createAgentYamlStore(): AgentYamlStore {
  return {
    async createAgent(projectPath: string, agent: AgentYaml): Promise<void> {
      const validated = AgentYamlSchema.parse(agent);
      const agentsDir = join(projectPath, 'agents');
      await mkdir(agentsDir, { recursive: true });
      const filePath = join(agentsDir, `${validated.name}.yaml`);
      const yaml = dump(validated, { lineWidth: LINE_WIDTH });
      await writeFile(filePath, yaml, 'utf-8');
      log.info(`Created agent YAML: ${validated.name} at ${filePath}`);
    },

    async updateAgent(
      projectPath: string,
      agentName: string,
      updates: Partial<AgentYaml>,
    ): Promise<AgentYaml> {
      const filePath = join(projectPath, 'agents', `${agentName}.yaml`);
      const content = await readFile(filePath, 'utf-8');
      const existing = yamlLoad(content) as Record<string, unknown>;
      const merged = { ...existing, ...updates, name: agentName };
      const validated = AgentYamlSchema.parse(merged);
      const yaml = dump(validated, { lineWidth: LINE_WIDTH });
      await writeFile(filePath, yaml, 'utf-8');
      log.info(`Updated agent YAML: ${agentName} at ${filePath}`);
      return validated;
    },

    async deleteAgent(projectPath: string, agentName: string): Promise<void> {
      const filePath = join(projectPath, 'agents', `${agentName}.yaml`);
      await unlink(filePath);
      log.info(`Deleted agent YAML: ${agentName} at ${filePath}`);
    },
  };
}
