import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import { createLogger, AgentYamlSchema, ScheduleYamlSchema } from '@raven/shared';
import type { AgentYaml, ScheduleYaml, ProjectNode, ProjectIndex } from '@raven/shared';

const log = createLogger('project-scanner');

const SKIP_DIRS = new Set(['agents', 'templates', 'schedules', 'node_modules', '.git']);

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function loadAgentYamls(agentsDir: string): Promise<AgentYaml[]> {
  const agents: AgentYaml[] = [];
  let entries: string[];
  try {
    const dirEntries = await readdir(agentsDir, { withFileTypes: true });
    entries = dirEntries
      .filter((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')))
      .map((e) => e.name);
  } catch {
    return agents;
  }

  for (const name of entries) {
    try {
      const content = await readFile(join(agentsDir, name), 'utf-8');
      const raw = yamlLoad(content);
      const parsed = AgentYamlSchema.parse(raw);
      agents.push(parsed);
    } catch {
      log.warn(`Skipping invalid agent YAML: ${name}`);
    }
  }
  return agents;
}

async function loadScheduleYamls(schedulesDir: string): Promise<ScheduleYaml[]> {
  const schedules: ScheduleYaml[] = [];
  let entries: string[];
  try {
    const dirEntries = await readdir(schedulesDir, { withFileTypes: true });
    entries = dirEntries
      .filter((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')))
      .map((e) => e.name);
  } catch {
    return schedules;
  }

  for (const name of entries) {
    try {
      const content = await readFile(join(schedulesDir, name), 'utf-8');
      const raw = yamlLoad(content);
      const parsed = ScheduleYamlSchema.parse(raw);
      schedules.push(parsed);
    } catch {
      log.warn(`Skipping invalid schedule YAML: ${name}`);
    }
  }
  return schedules;
}

interface ScanContext {
  projectsDir: string;
  projects: Map<string, ProjectNode>;
}

function deriveProjectName(rel: string): string {
  const parts = rel.split('/');
  return parts[parts.length - 1] ?? '_global';
}

async function scanSubdirectories(dirPath: string, id: string, ctx: ScanContext): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !shouldSkipDir(entry.name)) {
      await scanDir(join(dirPath, entry.name), id, ctx);
    }
  }
}

async function scanDir(dirPath: string, parentId: string | null, ctx: ScanContext): Promise<void> {
  const rel = relative(ctx.projectsDir, dirPath);
  const id = rel || '_global';
  const name = rel ? deriveProjectName(rel) : '_global';

  const contextMd = await readTextFile(join(dirPath, 'context.md'));

  // For non-global: must have context.md to be a project
  if (id !== '_global' && contextMd === null) {
    return;
  }

  const agents = await loadAgentYamls(join(dirPath, 'agents'));
  const schedules = await loadScheduleYamls(join(dirPath, 'schedules'));
  const isMeta = parentId === '_global' && name === 'system';

  const node: ProjectNode = {
    id,
    name,
    path: dirPath,
    relativePath: rel || '.',
    parentId,
    systemAccess: 'none',
    isMeta,
    contextMd: contextMd ?? '',
    agents,
    schedules,
    children: [],
  };

  ctx.projects.set(id, node);

  // Register as child of parent
  if (parentId !== null) {
    const parent = ctx.projects.get(parentId);
    if (parent) {
      parent.children.push(id);
    }
  }

  await scanSubdirectories(dirPath, id, ctx);
}

export async function scanProjects(projectsDir: string): Promise<ProjectIndex> {
  const ctx: ScanContext = {
    projectsDir,
    projects: new Map<string, ProjectNode>(),
  };

  await scanDir(projectsDir, null, ctx);

  const rootProjects = [...ctx.projects.values()]
    .filter((p) => p.parentId === '_global')
    .map((p) => p.id);

  return { projects: ctx.projects, rootProjects };
}
