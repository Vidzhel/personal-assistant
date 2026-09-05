import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createLogger,
  generateId,
  type EventBusInterface,
  type NamedAgent,
  type NamedAgentCreateInput,
  type NamedAgentUpdateInput,
  type AgentYaml,
} from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { AgentYamlStore } from '../project-registry/agent-yaml-store.ts';

const log = createLogger('yaml-named-agent-store');

export interface NamedAgentStore {
  createAgent: (
    input: NamedAgentCreateInput,
    options?: { projectScope?: string },
  ) => Promise<NamedAgent>;
  updateAgent: (id: string, input: NamedAgentUpdateInput) => Promise<NamedAgent>;
  deleteAgent: (id: string) => Promise<void>;
  getAgent: (id: string) => NamedAgent | undefined;
  getAgentByName: (name: string) => NamedAgent | undefined;
  getDefaultAgent: () => NamedAgent;
  listAgents: () => NamedAgent[];
}

interface AgentLocation {
  yaml: AgentYaml;
  projectPath: string;
  filePath: string;
}

interface StoreDeps {
  projectRegistry: ProjectRegistry;
  agentYamlStore: AgentYamlStore;
  projectsDir: string;
  eventBus: EventBusInterface;
}

function resolveFilePath(projectPath: string, name: string): string {
  const dirLayout = join(projectPath, 'agents', name, 'agent.yaml');
  if (existsSync(dirLayout)) return dirLayout;
  return join(projectPath, 'agents', `${name}.yaml`);
}

function yamlToNamedAgent(loc: AgentLocation): NamedAgent {
  let createdAt = new Date(0).toISOString();
  let updatedAt = createdAt;
  try {
    const st = statSync(loc.filePath);
    createdAt = st.birthtime.toISOString();
    updatedAt = st.mtime.toISOString();
  } catch {
    // File may be mid-move; timestamps are informational only
  }
  return {
    id: loc.yaml.name,
    name: loc.yaml.name,
    description: loc.yaml.description === '' ? null : (loc.yaml.description ?? null),
    instructions: loc.yaml.instructions ?? null,
    skills: loc.yaml.skills,
    model: loc.yaml.model ?? null,
    maxTurns: loc.yaml.maxTurns ?? null,
    ...(loc.yaml.bash !== undefined && { bash: loc.yaml.bash }),
    isDefault: loc.yaml.isDefault ?? false,
    createdAt,
    updatedAt,
  };
}

function inputToYaml(input: NamedAgentCreateInput): AgentYaml {
  return {
    name: input.name,
    displayName: input.name,
    description: input.description ?? '',
    isDefault: false,
    skills: input.skills,
    ...(input.instructions !== undefined && { instructions: input.instructions }),
    ...(input.model !== undefined && { model: input.model }),
    ...(input.maxTurns !== undefined && { maxTurns: input.maxTurns }),
    ...(input.bash !== undefined && { bash: input.bash }),
  } as AgentYaml;
}

// `undefined` means "leave unchanged". A nullable API value of `null` clears
// the override; AgentYamlStore's schema then materializes its documented
// default (sonnet/15) rather than silently retaining the previous setting.
function patchNullableField<K extends 'model' | 'maxTurns'>(
  patch: Partial<AgentYaml>,
  key: K,
  value: AgentYaml[K] | null | undefined,
): void {
  if (value === undefined) return;
  patch[key] = value === null ? undefined : value;
}

function updateInputToYamlPatch(input: NamedAgentUpdateInput): Partial<AgentYaml> {
  const patch: Partial<AgentYaml> = {};
  if (input.description !== undefined) patch.description = input.description ?? '';
  if (input.instructions !== undefined) patch.instructions = input.instructions ?? '';
  if (input.skills !== undefined) patch.skills = input.skills;
  if (input.bash !== undefined) patch.bash = input.bash;
  patchNullableField(patch, 'model', input.model);
  patchNullableField(patch, 'maxTurns', input.maxTurns);
  return patch;
}

// eslint-disable-next-line max-lines-per-function -- factory initializing all store methods
export function createYamlNamedAgentStore(deps: StoreDeps): NamedAgentStore {
  const { projectRegistry, agentYamlStore, projectsDir, eventBus } = deps;

  function collectLocations(): Map<string, AgentLocation> {
    const locations = new Map<string, AgentLocation>();
    const nodes = [];
    try {
      nodes.push(projectRegistry.getGlobal());
    } catch {
      // Registry not loaded yet — empty store
    }
    nodes.push(...projectRegistry.listProjects());

    for (const node of nodes) {
      for (const agentYaml of node.agents) {
        if (locations.has(agentYaml.name)) continue; // global wins on name conflict
        locations.set(agentYaml.name, {
          yaml: agentYaml,
          projectPath: node.path,
          filePath: resolveFilePath(node.path, agentYaml.name),
        });
      }
    }
    return locations;
  }

  function getLocation(idOrName: string): AgentLocation | undefined {
    return collectLocations().get(idOrName);
  }

  interface EmitAgentEventOptions {
    type: 'agent:config:created' | 'agent:config:updated' | 'agent:config:deleted';
    agent: NamedAgent;
    filePath: string;
    extra?: Record<string, unknown>;
  }

  function emitEvent(options: EmitAgentEventOptions): void {
    const { type, agent, filePath, extra } = options;
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'named-agent-store',
      type,
      payload: {
        agentId: agent.id,
        name: agent.name,
        skills: agent.skills,
        filePath,
        ...extra,
      },
    });
  }

  const store: NamedAgentStore = {
    getAgent(id: string): NamedAgent | undefined {
      const loc = getLocation(id);
      return loc ? yamlToNamedAgent(loc) : undefined;
    },

    getAgentByName(name: string): NamedAgent | undefined {
      return store.getAgent(name);
    },

    getDefaultAgent(): NamedAgent {
      for (const loc of collectLocations().values()) {
        if (loc.yaml.isDefault) return yamlToNamedAgent(loc);
      }
      throw new Error('No default agent configured');
    },

    listAgents(): NamedAgent[] {
      const agents = [...collectLocations().values()].map(yamlToNamedAgent);
      agents.sort((a, b) =>
        a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1,
      );
      return agents;
    },

    async createAgent(
      input: NamedAgentCreateInput,
      options?: { projectScope?: string },
    ): Promise<NamedAgent> {
      if (getLocation(input.name)) {
        throw new Error(`Agent name already exists: ${input.name}`);
      }
      const targetDir = options?.projectScope
        ? resolve(projectsDir, options.projectScope)
        : projectsDir;
      const filePath = await agentYamlStore.createAgent(targetDir, inputToYaml(input));
      await projectRegistry.load(projectsDir);

      const loc = getLocation(input.name);
      if (!loc) throw new Error(`Agent creation failed to register: ${input.name}`);
      const agent = yamlToNamedAgent(loc);
      log.info(`Named agent created: ${agent.name}`);
      emitEvent({ type: 'agent:config:created', agent, filePath });
      return agent;
    },

    async updateAgent(id: string, input: NamedAgentUpdateInput): Promise<NamedAgent> {
      const loc = getLocation(id);
      if (!loc) throw new Error(`Named agent not found: ${id}`);

      const isRename = input.name !== undefined && input.name !== loc.yaml.name;
      if (isRename && loc.yaml.isDefault) {
        throw new Error('Cannot rename the default agent');
      }
      if (isRename && getLocation(input.name as string)) {
        throw new Error(`Agent name already exists: ${input.name}`);
      }

      const patch = updateInputToYamlPatch(input);

      if (isRename) {
        const newName = input.name as string;
        const mergedYaml = {
          ...loc.yaml,
          ...patch,
          name: newName,
          displayName: newName,
        } as AgentYaml;
        const filePath = await agentYamlStore.createAgent(loc.projectPath, mergedYaml);
        await agentYamlStore.deleteAgent(loc.projectPath, loc.yaml.name);
        await projectRegistry.load(projectsDir);
        const newLoc = getLocation(newName);
        if (!newLoc) throw new Error(`Agent rename failed to register: ${newName}`);
        const agent = yamlToNamedAgent(newLoc);
        log.info(`Named agent renamed: ${id} → ${newName}`);
        emitEvent({
          type: 'agent:config:updated',
          agent,
          filePath,
          extra: { changes: Object.keys(input) },
        });
        return agent;
      }

      await agentYamlStore.updateAgent(loc.projectPath, loc.yaml.name, patch);
      await projectRegistry.load(projectsDir);
      const updatedLoc = getLocation(id);
      if (!updatedLoc) throw new Error(`Agent update failed to register: ${id}`);
      const agent = yamlToNamedAgent(updatedLoc);
      log.info(`Named agent updated: ${agent.name} [${Object.keys(input).join(', ')}]`);
      emitEvent({
        type: 'agent:config:updated',
        agent,
        filePath: updatedLoc.filePath,
        extra: { changes: Object.keys(input) },
      });
      return agent;
    },

    async deleteAgent(id: string): Promise<void> {
      const loc = getLocation(id);
      if (!loc) throw new Error(`Named agent not found: ${id}`);
      if (loc.yaml.isDefault) throw new Error('Cannot delete the default agent');

      const agent = yamlToNamedAgent(loc);
      await agentYamlStore.deleteAgent(loc.projectPath, loc.yaml.name);
      await projectRegistry.load(projectsDir);
      log.info(`Named agent deleted: ${agent.name}`);
      emitEvent({ type: 'agent:config:deleted', agent, filePath: loc.filePath });
    },
  };

  return store;
}
