import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import yaml from 'js-yaml';

import { AgentYamlSchema, ScheduleYamlSchema, TaskTemplateSchema } from '@raven/shared';
import type { TaskTemplate } from '@raven/shared';

const yamlLoad = yaml.load;

const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(['agents', 'templates', 'schedules', 'node_modules', '.git']);

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

interface YamlValidateOpts {
  dir: string;
  schema: typeof AgentYamlSchema | typeof ScheduleYamlSchema;
  kind: string;
  projectRel: string;
}

async function validateYamlFiles(opts: YamlValidateOpts): Promise<string[]> {
  const errors: string[] = [];
  let entries;
  try {
    entries = await readdir(opts.dir, { withFileTypes: true });
  } catch {
    return errors;
  }

  const yamlFiles = entries.filter(
    (e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')),
  );

  for (const entry of yamlFiles) {
    const filePath = join(opts.dir, entry.name);
    try {
      const content = await readFile(filePath, 'utf-8');
      const raw = yamlLoad(content);
      opts.schema.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Invalid ${opts.kind} YAML in ${opts.projectRel}/${entry.name}: ${msg}`);
    }
  }

  return errors;
}

function checkBashAccess(
  agentRaw: Record<string, unknown>,
  agentName: string,
  projectRel: string,
): string | null {
  const bash = agentRaw.bash as Record<string, unknown> | undefined;
  if (!bash || bash.access !== 'full') return null;

  const isGlobalAgents = projectRel === '' || projectRel === '.';
  const isSystemAgents = projectRel === 'system';
  if (isGlobalAgents || isSystemAgents) return null;

  return `bash.access: full not allowed for agent "${agentName}" in project "${projectRel || '_global'}" (only global or system)`;
}

async function validateAgentsDir(
  agentsDir: string,
  projectRel: string,
  seenAgentNames: Set<string>,
): Promise<string[]> {
  const errors: string[] = [];
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return errors;
  }

  const yamlFiles = entries.filter(
    (e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')),
  );

  for (const entry of yamlFiles) {
    const filePath = join(agentsDir, entry.name);
    try {
      const content = await readFile(filePath, 'utf-8');
      const raw = yamlLoad(content) as Record<string, unknown>;
      const parsed = AgentYamlSchema.parse(raw);

      if (seenAgentNames.has(parsed.name)) {
        errors.push(
          `Duplicate agent name "${parsed.name}" in project "${projectRel || '_global'}"`,
        );
      } else {
        seenAgentNames.add(parsed.name);
      }

      const bashErr = checkBashAccess(raw, parsed.name, projectRel);
      if (bashErr) errors.push(bashErr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Invalid agent YAML in ${projectRel || '_global'}/${entry.name}: ${msg}`);
    }
  }

  return errors;
}

interface ValidateContext {
  projectsDir: string;
  errors: string[];
}

async function isProjectDir(dirPath: string, isRoot: boolean): Promise<boolean> {
  if (isRoot) return true;
  try {
    await readFile(join(dirPath, 'context.md'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

async function getSubdirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !shouldSkipDir(e.name))
      .map((e) => join(dirPath, e.name));
  } catch {
    return [];
  }
}

interface TemplateGraph {
  taskIds: Set<string>;
  blockedByMap: Map<string, string[]>;
}

/** Build in-degree and dependents maps for Kahn's algorithm. */
function buildTemplateGraph(graph: TemplateGraph): {
  inDegree: Map<string, number>;
  dependents: Map<string, string[]>;
} {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const id of graph.taskIds) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const [id, deps] of graph.blockedByMap) {
    const validDeps = deps.filter((d) => graph.taskIds.has(d));
    inDegree.set(id, validDeps.length);
    for (const dep of validDeps) {
      dependents.get(dep)?.push(id);
    }
  }

  return { inDegree, dependents };
}

/** Run Kahn's topological sort, return sorted node IDs. */
function kahnSortTemplate(
  inDegree: Map<string, number>,
  dependents: Map<string, string[]>,
): string[] {
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    sorted.push(node);
    for (const dep of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }
  return sorted;
}

/** Detect cycles using Kahn's algorithm. Returns IDs in cycles (empty = acyclic). */
function detectCycles(graph: TemplateGraph): string[] {
  const { inDegree, dependents } = buildTemplateGraph(graph);
  const sorted = kahnSortTemplate(inDegree, dependents);
  if (sorted.length < graph.taskIds.size) {
    const sortedSet = new Set(sorted);
    return [...graph.taskIds].filter((id) => !sortedSet.has(id));
  }
  return [];
}

/** Extract task IDs and blockedBy map from a parsed template. */
function extractGraph(template: TaskTemplate): TemplateGraph {
  const taskIds = new Set<string>();
  const blockedByMap = new Map<string, string[]>();
  for (const task of template.tasks) {
    const t = task as { id: string; blockedBy?: string[] };
    taskIds.add(t.id);
    blockedByMap.set(t.id, t.blockedBy ?? []);
  }
  return { taskIds, blockedByMap };
}

/** Check blockedBy refs, cycles, and forEach syntax for a single template. */
function validateTemplateStructure(template: TaskTemplate, label: string): string[] {
  const errors: string[] = [];
  const graph = extractGraph(template);

  for (const [id, deps] of graph.blockedByMap) {
    for (const dep of deps) {
      if (!graph.taskIds.has(dep)) {
        errors.push(`Template ${label}: task "${id}" references missing dependency "${dep}"`);
      }
    }
  }

  const cycleNodes = detectCycles(graph);
  if (cycleNodes.length > 0) {
    errors.push(`Template ${label}: circular dependency involving tasks: ${cycleNodes.join(', ')}`);
  }

  for (const task of template.tasks) {
    const t = task as { id: string; forEach?: string };
    if (t.forEach && !t.forEach.includes('{{')) {
      errors.push(`Template ${label}: task "${t.id}" forEach must contain {{ }} expression`);
    }
  }

  return errors;
}

async function validateTemplatesDir(templatesDir: string, projectRel: string): Promise<string[]> {
  const errors: string[] = [];
  let entries;
  try {
    entries = await readdir(templatesDir, { withFileTypes: true });
  } catch {
    return errors;
  }

  const yamlFiles = entries.filter(
    (e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')),
  );

  for (const entry of yamlFiles) {
    const filePath = join(templatesDir, entry.name);
    const label = `${projectRel}/templates/${entry.name}`;
    try {
      const content = await readFile(filePath, 'utf-8');
      const raw = yamlLoad(content);
      const template = TaskTemplateSchema.parse(raw) as TaskTemplate;
      errors.push(...validateTemplateStructure(template, label));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Invalid template YAML in ${label}: ${msg}`);
    }
  }

  return errors;
}

async function validateDir(dirPath: string, depth: number, ctx: ValidateContext): Promise<void> {
  const rel = relative(ctx.projectsDir, dirPath);
  const isRoot = rel === '' || rel === '.';

  if (!isRoot && depth > MAX_DEPTH) {
    ctx.errors.push(`Project nested too deep (>${MAX_DEPTH} levels): ${rel}`);
    return;
  }

  if (!(await isProjectDir(dirPath, isRoot))) return;

  const agentNames = new Set<string>();
  const agentErrors = await validateAgentsDir(join(dirPath, 'agents'), rel, agentNames);
  ctx.errors.push(...agentErrors);

  const scheduleErrors = await validateYamlFiles({
    dir: join(dirPath, 'schedules'),
    schema: ScheduleYamlSchema,
    kind: 'schedule',
    projectRel: rel || '_global',
  });
  ctx.errors.push(...scheduleErrors);

  const templateErrors = await validateTemplatesDir(join(dirPath, 'templates'), rel || '_global');
  ctx.errors.push(...templateErrors);

  const subdirs = await getSubdirectories(dirPath);
  for (const subdir of subdirs) {
    await validateDir(subdir, depth + 1, ctx);
  }
}

export async function validateProjects(projectsDir: string): Promise<string[]> {
  const ctx: ValidateContext = {
    projectsDir,
    errors: [],
  };

  await validateDir(projectsDir, 0, ctx);
  return ctx.errors;
}
