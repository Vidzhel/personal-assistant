import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  AgentYamlSchema,
  createLogger,
  generateId,
  META_PROJECT_ID,
  type EventBusInterface,
  type NamedAgent,
  type NamedAgentCreateInput,
  type NamedAgentUpdateInput,
  type AgentYaml,
  type ProjectNode,
} from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { AgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import { readProjectTextFile } from '../project-manager/project-file-read.ts';
import { readProjectDefinition } from '../project-registry/project-definition.ts';
import { withProjectMutation } from '../project-manager/project-mutation.ts';

const { load: yamlLoad } = yaml;
const log = createLogger('yaml-named-agent-store');
const MAX_AGENT_BYTES = 1_048_576;
const QUALIFIED_SEPARATOR = '::';

export interface NamedAgentStore {
  createAgent: (
    input: NamedAgentCreateInput,
    options?: { projectScope?: string },
  ) => Promise<NamedAgent>;
  updateAgent: (id: string, input: NamedAgentUpdateInput) => Promise<NamedAgent>;
  deleteAgent: (id: string) => Promise<void>;
  getAgent: (id: string) => NamedAgent | undefined;
  getAgentByName: (name: string, projectId?: string) => NamedAgent | undefined;
  getDefaultAgent: (projectId?: string) => NamedAgent;
  listAgents: (projectId?: string) => NamedAgent[];
}

interface AgentLocation {
  yaml: AgentYaml;
  node: ProjectNode;
  projectPath: string;
  projectId?: string;
  filePath: string;
  revision: string;
}

interface StoreDeps {
  projectRegistry: ProjectRegistry;
  agentYamlStore: AgentYamlStore;
  projectsDir: string;
  eventBus: EventBusInterface;
}

function projectIdentity(node: ProjectNode): string | undefined {
  if (node.id === '_global') return undefined;
  return node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id);
}

function qualifiedId(node: ProjectNode, name: string): string {
  const identity = projectIdentity(node);
  return identity === undefined ? name : `${identity}${QUALIFIED_SEPARATOR}${name}`;
}

function fileCandidates(projectPath: string, name: string): string[] {
  return [
    join(projectPath, 'agents', name, 'agent.yaml'),
    join(projectPath, 'agents', `${name}.yaml`),
  ];
}

function assertCanonicalFile(filePath: string): void {
  if (!existsSync(filePath) || realpathSync(filePath) !== resolve(filePath)) {
    throw new Error(`Agent definition path is unavailable or unsafe: ${filePath}`);
  }
}

function assertCanonicalDirectory(directory: string): void {
  if (!existsSync(directory) || realpathSync(directory) !== resolve(directory)) {
    throw new Error(`Agent project path is unavailable or unsafe: ${directory}`);
  }
}

function assertCurrentProject(node: ProjectNode): void {
  assertCanonicalDirectory(node.path);
  const context = readProjectTextFile(join(node.path, 'context.md'), MAX_AGENT_BYTES);
  if (node.id === '_global' && context === undefined) return;
  if (context === undefined) throw new Error(`Project definition is unavailable: ${node.id}`);
  const current = readProjectDefinition(context);
  const expected = projectIdentity(node);
  const actual =
    node.id === '_global'
      ? undefined
      : (current.metadata?.id ?? (node.isMeta ? META_PROJECT_ID : node.id));
  if (actual !== expected) throw new Error(`Project identity changed: ${node.id}`);
}

function readCurrentYaml(
  node: ProjectNode,
  declaredName: string,
  projectsDir: string,
): AgentLocation {
  const filePath = fileCandidates(node.path, declaredName).find((candidate) =>
    existsSync(candidate),
  );
  if (!filePath) throw new Error(`Agent definition is unavailable: ${declaredName}`);
  assertCanonicalFile(filePath);
  const bytes = readProjectTextFile(filePath, MAX_AGENT_BYTES);
  if (bytes === undefined) throw new Error(`Agent definition is unavailable: ${declaredName}`);
  const parsed = AgentYamlSchema.parse(yamlLoad(bytes));
  if (parsed.name !== declaredName) {
    throw new Error(`Agent definition identity changed: ${declaredName}`);
  }
  const identityPath = relative(resolve(projectsDir), resolve(filePath));
  const revision = createHash('sha256')
    .update(bytes)
    .update('\0')
    .update(identityPath)
    .digest('hex');
  return {
    yaml: parsed,
    node,
    projectPath: node.path,
    projectId: projectIdentity(node),
    filePath,
    revision,
  };
}

function yamlToNamedAgent(loc: AgentLocation): NamedAgent {
  let createdAt = new Date(0).toISOString();
  let updatedAt = createdAt;
  try {
    const st = statSync(loc.filePath);
    createdAt = st.birthtime.toISOString();
    updatedAt = st.mtime.toISOString();
  } catch {
    // The definition can be replaced between validation and presentation.
  }
  return {
    id: qualifiedId(loc.node, loc.yaml.name),
    name: loc.yaml.name,
    ...(loc.projectId !== undefined ? { projectId: loc.projectId } : {}),
    definitionRevision: loc.revision,
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
  return AgentYamlSchema.parse({
    name: input.name,
    displayName: input.name,
    description: input.description ?? '',
    isDefault: false,
    skills: input.skills,
    ...(input.instructions !== undefined && { instructions: input.instructions }),
    ...(input.model !== undefined && { model: input.model }),
    ...(input.maxTurns !== undefined && { maxTurns: input.maxTurns }),
    ...(input.bash !== undefined && { bash: input.bash }),
  });
}

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

function resolveScopeNode(projectRegistry: ProjectRegistry, projectId: string): ProjectNode {
  projectRegistry.assertHealthy();
  if (projectId === '.' || projectId === '_global') return projectRegistry.getGlobal();
  const matches = [projectRegistry.getGlobal(), ...projectRegistry.listProjects()].filter(
    (node) => node.id === projectId || projectIdentity(node) === projectId,
  );
  if (matches.length === 0) throw new Error(`Project not found: ${projectId}`);
  if (matches.length > 1) throw new Error(`Project identity is ambiguous: ${projectId}`);
  return matches[0];
}

function ancestorChain(projectRegistry: ProjectRegistry, node: ProjectNode): ProjectNode[] {
  const chain: ProjectNode[] = [];
  const seen = new Set<string>();
  let current: ProjectNode | undefined = node;
  while (current) {
    assertCurrentProject(current);
    if (seen.has(current.id)) throw new Error('Project hierarchy contains a cycle');
    seen.add(current.id);
    chain.push(current);
    if (current.parentId === null) break;
    current = projectRegistry.getProject(current.parentId);
    if (!current) throw new Error(`Project parent is unavailable: ${node.id}`);
  }
  return chain;
}

function allNodes(projectRegistry: ProjectRegistry): ProjectNode[] {
  return [projectRegistry.getGlobal(), ...projectRegistry.listProjects()];
}

function isVisible(input: {
  projectRegistry: ProjectRegistry;
  scope: ProjectNode;
  candidate: ProjectNode;
}): boolean {
  return ancestorChain(input.projectRegistry, input.scope).some(
    (node) => node.id === input.candidate.id,
  );
}

function splitQualifiedId(value: string): { projectId: string; name: string } | undefined {
  const index = value.lastIndexOf(QUALIFIED_SEPARATOR);
  if (index <= 0 || index === value.length - QUALIFIED_SEPARATOR.length) return undefined;
  return {
    projectId: value.slice(0, index),
    name: value.slice(index + QUALIFIED_SEPARATOR.length),
  };
}

function locationForNode(
  node: ProjectNode,
  name: string,
  projectsDir: string,
): AgentLocation | undefined {
  const known = node.agents.some((agent) => agent.name === name);
  if (!known) return undefined;
  assertCurrentProject(node);
  return readCurrentYaml(node, name, projectsDir);
}

function findQualifiedLocation(
  projectRegistry: ProjectRegistry,
  projectsDir: string,
  id: string,
): AgentLocation | undefined {
  const qualified = splitQualifiedId(id);
  if (!qualified) return locationForNode(projectRegistry.getGlobal(), id, projectsDir);
  const node = resolveScopeNode(projectRegistry, qualified.projectId);
  return locationForNode(node, qualified.name, projectsDir);
}

function duplicateInNode(node: ProjectNode, name: string): boolean {
  return node.agents.some((agent) => agent.name === name);
}

// eslint-disable-next-line max-lines-per-function -- factory initializes the small file-backed store API
export function createYamlNamedAgentStore(deps: StoreDeps): NamedAgentStore {
  const { projectRegistry, agentYamlStore, projectsDir, eventBus } = deps;

  function emitEvent(options: {
    type: 'agent:config:created' | 'agent:config:updated' | 'agent:config:deleted';
    agent: NamedAgent;
    filePaths: string[];
    extra?: Record<string, unknown>;
  }): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'named-agent-store',
      type: options.type,
      payload: {
        agentId: options.agent.id,
        name: options.agent.name,
        skills: options.agent.skills,
        filePaths: options.filePaths,
        ...options.extra,
      },
    });
  }

  function currentLocation(id: string): AgentLocation | undefined {
    projectRegistry.assertHealthy();
    const location = findQualifiedLocation(projectRegistry, projectsDir, id);
    if (location) ancestorChain(projectRegistry, location.node);
    return location;
  }

  function scopedLocations(projectId?: string): AgentLocation[] {
    projectRegistry.assertHealthy();
    const scope =
      projectId === undefined ? undefined : resolveScopeNode(projectRegistry, projectId);
    const nodes = scope
      ? ancestorChain(projectRegistry, scope).reverse()
      : allNodes(projectRegistry);
    const locations = new Map<string, AgentLocation>();
    for (const node of nodes) {
      for (const declared of node.agents) {
        const location = locationForNode(node, declared.name, projectsDir);
        if (!location) continue;
        if (scope) {
          if (locations.has(declared.name)) locations.delete(declared.name);
          locations.set(declared.name, location);
        } else {
          locations.set(qualifiedId(node, declared.name), location);
        }
      }
    }
    return [...locations.values()];
  }

  function defaultLocation(projectId?: string): AgentLocation | undefined {
    projectRegistry.assertHealthy();
    const scope =
      projectId === undefined ? undefined : resolveScopeNode(projectRegistry, projectId);
    if (!scope) {
      const global = projectRegistry.getGlobal();
      assertCurrentProject(global);
      return global.agents
        .map((declared) => locationForNode(global, declared.name, projectsDir))
        .find((location) => location?.yaml.isDefault);
    }
    const effective = scopedLocations(projectId);

    // Walk nearest-first so a local explicit default wins over every ancestor.
    // Resolve the selected name through the effective set: a local definition
    // can shadow an inherited default by name even when its own flag is false.
    for (const ancestor of ancestorChain(projectRegistry, scope)) {
      const inherited = ancestor.agents
        .map((declared) => locationForNode(ancestor, declared.name, projectsDir))
        .find((location) => location?.yaml.isDefault);
      if (!inherited) continue;
      return effective.find((location) => location.yaml.name === inherited.yaml.name);
    }
    return undefined;
  }

  async function renameAgent(
    location: AgentLocation,
    input: NamedAgentUpdateInput,
  ): Promise<{ filePath: string; filePaths: string[] }> {
    if (location.yaml.isDefault) throw new Error('Cannot rename the default agent');
    const newName = input.name as string;
    if (duplicateInNode(location.node, newName))
      throw new Error(`Agent name already exists: ${newName}`);
    const mergedYaml = AgentYamlSchema.parse({
      ...location.yaml,
      ...updateInputToYamlPatch(input),
      name: newName,
      displayName: newName,
    });
    const filePath = await agentYamlStore.createAgent(location.projectPath, mergedYaml);
    await agentYamlStore.deleteAgent(location.projectPath, location.yaml.name);
    return { filePath, filePaths: [location.filePath, filePath] };
  }

  const store: NamedAgentStore = {
    getAgent(id: string): NamedAgent | undefined {
      const location = currentLocation(id);
      return location ? yamlToNamedAgent(location) : undefined;
    },

    getAgentByName(name: string, projectId?: string): NamedAgent | undefined {
      projectRegistry.assertHealthy();
      const qualified = splitQualifiedId(name);
      if (qualified) {
        if (projectId === undefined) throw new Error('Qualified agent lookup requires a project');
        const scope = resolveScopeNode(projectRegistry, projectId);
        const owner = resolveScopeNode(projectRegistry, qualified.projectId);
        if (!isVisible({ projectRegistry, scope, candidate: owner }))
          throw new Error(`Agent belongs to an unrelated project: ${name}`);
        const location = locationForNode(owner, qualified.name, projectsDir);
        return location ? yamlToNamedAgent(location) : undefined;
      }
      const candidates =
        projectId === undefined
          ? [locationForNode(projectRegistry.getGlobal(), name, projectsDir)].filter(
              (candidate): candidate is AgentLocation => candidate !== undefined,
            )
          : scopedLocations(projectId);
      const location = candidates.find((candidate) => candidate.yaml.name === name);
      return location ? yamlToNamedAgent(location) : undefined;
    },

    getDefaultAgent(projectId?: string): NamedAgent {
      const location = defaultLocation(projectId);
      if (!location) throw new Error('No default agent configured');
      return yamlToNamedAgent(location);
    },

    listAgents(projectId?: string): NamedAgent[] {
      const agents = scopedLocations(projectId).map(yamlToNamedAgent);
      agents.sort((a, b) =>
        a.isDefault === b.isDefault ? a.id.localeCompare(b.id) : a.isDefault ? -1 : 1,
      );
      return agents;
    },

    async createAgent(
      input: NamedAgentCreateInput,
      options?: { projectScope?: string },
    ): Promise<NamedAgent> {
      const result = await withProjectMutation(projectsDir, async () => {
        const target = options?.projectScope
          ? resolveScopeNode(projectRegistry, options.projectScope)
          : projectRegistry.getGlobal();
        if (duplicateInNode(target, input.name))
          throw new Error(`Agent name already exists: ${input.name}`);
        ancestorChain(projectRegistry, target);
        assertCanonicalDirectory(target.path);
        const agentsDirectory = join(target.path, 'agents');
        if (existsSync(agentsDirectory)) assertCanonicalDirectory(agentsDirectory);
        const filePath = await agentYamlStore.createAgent(target.path, inputToYaml(input));
        return {
          filePath,
          filePaths: [filePath],
          targetId: projectIdentity(target) ?? target.id,
        };
      });
      await projectRegistry.load(projectsDir);
      const refreshed = resolveScopeNode(projectRegistry, result.targetId);
      const location = locationForNode(refreshed, input.name, projectsDir);
      if (!location) throw new Error(`Agent creation failed to register: ${input.name}`);
      const agent = yamlToNamedAgent(location);
      log.info(`Named agent created: ${agent.id}`);
      emitEvent({ type: 'agent:config:created', agent, filePaths: result.filePaths });
      return agent;
    },

    async updateAgent(id: string, input: NamedAgentUpdateInput): Promise<NamedAgent> {
      const result = await withProjectMutation(projectsDir, async () => {
        const location = currentLocation(id);
        if (!location) throw new Error(`Named agent not found: ${id}`);
        const isRename = input.name !== undefined && input.name !== location.yaml.name;
        if (isRename) {
          const renamed = await renameAgent(location, input);
          return { id: qualifiedId(location.node, input.name as string), ...renamed };
        }
        await agentYamlStore.updateAgent(
          location.projectPath,
          location.yaml.name,
          updateInputToYamlPatch(input),
        );
        return { id, filePath: location.filePath, filePaths: [location.filePath] };
      });
      await projectRegistry.load(projectsDir);
      const updated = currentLocation(result.id);
      if (!updated) throw new Error(`Agent update failed to register: ${id}`);
      const agent = yamlToNamedAgent(updated);
      emitEvent({
        type: 'agent:config:updated',
        agent,
        filePaths: result.filePaths,
        extra: { changes: Object.keys(input) },
      });
      return agent;
    },

    async deleteAgent(id: string): Promise<void> {
      const removed = await withProjectMutation(projectsDir, async () => {
        const location = currentLocation(id);
        if (!location) throw new Error(`Named agent not found: ${id}`);
        if (location.yaml.isDefault) throw new Error('Cannot delete the default agent');
        const agent = yamlToNamedAgent(location);
        await agentYamlStore.deleteAgent(location.projectPath, location.yaml.name);
        return { agent, filePath: location.filePath, filePaths: [location.filePath] };
      });
      await projectRegistry.load(projectsDir);
      log.info(`Named agent deleted: ${removed.agent.id}`);
      emitEvent({
        type: 'agent:config:deleted',
        agent: removed.agent,
        filePaths: removed.filePaths,
      });
    },
  };

  return store;
}
