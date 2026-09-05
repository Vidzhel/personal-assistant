import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  META_PROJECT_ID,
  type AgentTask,
  type ProjectNode,
  type ProjectWorkspace,
} from '@raven/shared';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ProjectWorkspaceStore } from './project-workspace.ts';
import { readProjectTextFile } from './project-file-read.ts';
import { readProjectDefinition } from '../project-registry/project-definition.ts';

const MAX_CONTEXT_BYTES = 1_048_576;
const MAX_PROJECT_DEPTH = 100;

export interface WorkspaceExecution {
  cwd: string;
  additionalDirectories: string[];
  mode: 'default' | 'auto' | 'full';
  settingSources: ('project' | 'local')[];
  revision: string;
}

export interface WorkspaceExecutionResolver {
  resolve(task: WorkspaceExecutionTask): WorkspaceExecution;
}

export type WorkspaceExecutionTask = Pick<AgentTask, 'projectId' | 'namedAgentId'> & {
  namedAgentRevision?: string;
  skillName?: string;
};

export interface WorkspaceExecutionResolverDeps {
  workspaceStore: ProjectWorkspaceStore;
  projectRegistry: ProjectRegistry;
  namedAgentStore: NamedAgentStore;
  runtimeRevision?: (task: WorkspaceExecutionTask) => string;
}

interface DirectoryRecord {
  path: string;
  dev: number;
  ino: number;
}

function projectNode(registry: ProjectRegistry, projectId: string): ProjectNode {
  registry.assertHealthy();
  const nodes = [registry.getGlobal(), ...registry.listProjects()];
  const node = nodes.find(
    (candidate) =>
      (candidate.isMeta ? META_PROJECT_ID : (candidate.metadata?.id ?? candidate.id)) === projectId,
  );
  if (!node) throw new Error('Project is unavailable: ' + projectId);
  return node;
}

function ancestorNodes(registry: ProjectRegistry, node: ProjectNode): ProjectNode[] {
  const chain: ProjectNode[] = [];
  const seen = new Set<string>();
  let current: ProjectNode | undefined = node;
  while (current) {
    if (seen.has(current.id)) throw new Error('Project hierarchy contains a cycle');
    seen.add(current.id);
    chain.unshift(current);
    const parentId: string | null = current.parentId;
    current = parentId === null ? undefined : registry.getProject(parentId);
    if (parentId !== null && !current) throw new Error('Project ancestor is unavailable');
    if (chain.length > MAX_PROJECT_DEPTH) throw new Error('Project hierarchy is too deep');
  }
  return chain;
}

function contextRevision(registry: ProjectRegistry, node: ProjectNode): string {
  const hash = createHash('sha256');
  for (const ancestor of ancestorNodes(registry, node)) {
    const bytes = readProjectTextFile(join(ancestor.path, 'context.md'), MAX_CONTEXT_BYTES);
    assertAncestorIdentity(ancestor, bytes);
    hash.update(ancestor.id + '\0' + (bytes ?? '') + '\0');
  }
  return hash.digest('hex');
}

function assertAncestorIdentity(ancestor: ProjectNode, bytes: string | undefined): void {
  if (ancestor.id === '_global') return;
  if (bytes === undefined) throw new Error('Project context is unavailable: ' + ancestor.id);
  const metadata = readProjectDefinition(bytes).metadata;
  const expected = ancestor.metadata?.id ?? (ancestor.isMeta ? META_PROJECT_ID : ancestor.id);
  const actual = metadata?.id ?? (ancestor.isMeta ? META_PROJECT_ID : ancestor.id);
  if (actual !== expected) throw new Error('Project identity changed: ' + ancestor.id);
}

function settingsRevision(cwd: string, attached: boolean): string {
  if (!attached) return '';
  const settingsDirectory = join(cwd, '.claude');
  try {
    const stat = lstatSync(settingsDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Project settings directory is unavailable: ' + settingsDirectory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  const hash = createHash('sha256');
  for (const name of ['settings.json', 'settings.local.json']) {
    const bytes = readProjectTextFile(join(settingsDirectory, name), MAX_CONTEXT_BYTES);
    hash.update(name + '\0' + (bytes ?? '') + '\0');
  }
  return hash.digest('hex');
}

function assertDirectory(path: string): DirectoryRecord {
  if (!isAbsolute(path)) throw new Error('Workspace directory must be absolute');
  const absolute = resolve(path);
  const stats = lstatSync(absolute);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Workspace directory is unavailable: ' + path);
  }
  if (realpathSync(absolute) !== absolute) {
    throw new Error('Workspace directory is not canonical: ' + path);
  }
  return { path: absolute, dev: stats.dev, ino: stats.ino };
}

function folderRecords(
  workspace: ProjectWorkspace,
  home: string,
): { cwd: string; records: DirectoryRecord[]; selected: boolean } {
  const folderSources = workspace.sources.filter((source) => source.sourceType === 'folder');
  const records = folderSources.map((source) => {
    const record = assertDirectory(source.uri);
    if (resolve(source.uri) !== record.path) {
      throw new Error('Folder source changed identity: ' + source.id);
    }
    return record;
  });
  const selectedSource = workspace.execution.sourceId
    ? folderSources.find((source) => source.id === workspace.execution.sourceId)
    : undefined;
  if (workspace.execution.sourceId && !selectedSource) {
    throw new Error('Selected workspace source is unavailable');
  }
  const selectedPath = selectedSource ? assertDirectory(selectedSource.uri).path : home;
  return {
    cwd: selectedPath,
    records: [assertDirectory(home), ...records],
    selected: selectedSource !== undefined,
  };
}

function uniqueDirectories(records: DirectoryRecord[]): DirectoryRecord[] {
  const seen = new Set<string>();
  return records
    .filter((record) => !seen.has(record.path) && seen.add(record.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertAgentInput(task: WorkspaceExecutionTask): void {
  if (
    task.namedAgentId !== undefined &&
    (typeof task.namedAgentId !== 'string' || task.namedAgentId.trim().length === 0)
  ) {
    throw new Error('Agent identity is malformed');
  }
  if (task.namedAgentRevision !== undefined && task.namedAgentId === undefined) {
    throw new Error('Agent revision requires an agent identity');
  }
}

function visibleAgent(
  deps: WorkspaceExecutionResolverDeps,
  agent: NonNullable<ReturnType<NamedAgentStore['getAgent']>>,
  projectId: string,
): NonNullable<ReturnType<NamedAgentStore['getAgent']>> {
  const effective = deps.namedAgentStore.getAgentByName(agent.name, projectId);
  if (!effective || effective.id !== agent.id || !effective.definitionRevision) {
    throw new Error('Agent is not visible in project');
  }
  return effective;
}

function assertAgentRevision(task: WorkspaceExecutionTask, revision: string): void {
  if (task.namedAgentRevision !== undefined && task.namedAgentRevision !== revision) {
    throw new Error('Agent definition changed');
  }
}

function agentRevision(
  deps: WorkspaceExecutionResolverDeps,
  task: WorkspaceExecutionTask,
  projectId: string,
): string {
  assertAgentInput(task);
  if (!task.namedAgentId) return '';
  const agent = deps.namedAgentStore.getAgent(task.namedAgentId);
  if (!agent?.definitionRevision) throw new Error('Agent definition is unavailable');
  const effective = visibleAgent(deps, agent, projectId);
  const revision = effective.definitionRevision;
  if (!revision) throw new Error('Agent definition is unavailable');
  assertAgentRevision(task, revision);
  return revision;
}

interface RevisionInput {
  workspace: ProjectWorkspace;
  context: string;
  directories: DirectoryRecord[];
  cwd: string;
  agent: string;
  settings: string;
  runtime: string;
}

function revisionHash(input: RevisionInput): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(input.workspace));
  hash.update(
    '\0' +
      input.context +
      '\0' +
      input.cwd +
      '\0' +
      input.agent +
      '\0' +
      input.settings +
      '\0' +
      input.runtime,
  );
  for (const record of input.directories) {
    hash.update('\0' + record.path + ':' + record.dev + ':' + record.ino);
  }
  return hash.digest('hex');
}

export function createWorkspaceExecutionResolver(
  deps: WorkspaceExecutionResolverDeps,
): WorkspaceExecutionResolver {
  return {
    resolve(task) {
      const projectId = task.projectId ?? META_PROJECT_ID;
      const node = projectNode(deps.projectRegistry, projectId);
      const workspace = deps.workspaceStore.getWorkspace(projectId);
      const home = deps.workspaceStore.getProjectHome(projectId);
      const folders = folderRecords(workspace, home);
      const allDirectories = uniqueDirectories(folders.records);
      const records = allDirectories.filter((record) => record.path !== folders.cwd);
      const agent = agentRevision(deps, task, projectId);
      return {
        cwd: folders.cwd,
        additionalDirectories: records.map((record) => record.path),
        mode: workspace.execution.mode,
        settingSources: folders.selected ? ['project', 'local'] : [],
        revision: revisionHash({
          workspace,
          context: contextRevision(deps.projectRegistry, node),
          directories: allDirectories,
          cwd: folders.cwd,
          agent,
          settings: settingsRevision(folders.cwd, folders.selected),
          runtime: deps.runtimeRevision?.(task) ?? '',
        }),
      };
    },
  };
}
