import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import yaml from 'js-yaml';

import {
  AgentYamlSchema,
  ScheduleYamlSchema,
  TaskTemplateSchema,
  META_PROJECT_ID,
} from '@raven/shared';
import type { TaskTemplate } from '@raven/shared';
import { readProjectDefinition } from './project-definition.ts';

const yamlLoad = yaml.load;

const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(['agents', 'templates', 'schedules', 'tasks', 'node_modules', '.git']);

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

export interface ValidatorOptions {
  knownSkills?: Set<string>;
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`Cannot read ${opts.kind} definitions ${opts.dir}: ${String(error)}`);
    }
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

interface PathTraversalContext {
  fieldName: string;
  agentName: string;
  projectRel: string;
}

function checkBashPathTraversal(paths: string[], ctx: PathTraversalContext): string[] {
  const errors: string[] = [];
  for (const p of paths) {
    if (p.includes('..')) {
      errors.push(
        `bash.${ctx.fieldName} contains path traversal ".." in agent "${ctx.agentName}" (project "${ctx.projectRel || '_global'}"): ${p}`,
      );
    }
  }
  return errors;
}

function checkDeniedPathsWarnings(
  bash: Record<string, unknown>,
  agentName: string,
  projectRel: string,
): string[] {
  const warnings: string[] = [];
  if (bash.access === 'none') return warnings;

  const deniedPaths = Array.isArray(bash.deniedPaths) ? (bash.deniedPaths as string[]) : [];

  if (!deniedPaths.some((p) => p.includes('.env'))) {
    warnings.push(
      `bash.deniedPaths for agent "${agentName}" in "${projectRel || '_global'}" does not include .env (mandatory denies cover this at runtime, but explicit denial is recommended)`,
    );
  }
  if (!deniedPaths.some((p) => p.includes('.git'))) {
    warnings.push(
      `bash.deniedPaths for agent "${agentName}" in "${projectRel || '_global'}" does not include .git (mandatory denies cover this at runtime, but explicit denial is recommended)`,
    );
  }

  return warnings;
}

interface BashCheckResult {
  errors: string[];
  warnings: string[];
}

function checkBashAccess(
  agentRaw: Record<string, unknown>,
  agentName: string,
  projectRel: string,
): BashCheckResult {
  const bash = agentRaw.bash as Record<string, unknown> | undefined;
  if (!bash) return { errors: [], warnings: [] };

  const errors: string[] = [];
  const warnings: string[] = [];

  // Full access restricted to global/system agents
  if (bash.access === 'full') {
    const isGlobalAgents = projectRel === '' || projectRel === '.';
    const isSystemAgents = projectRel === 'system';
    if (!isGlobalAgents && !isSystemAgents) {
      errors.push(
        `bash.access: full not allowed for agent "${agentName}" in project "${projectRel || '_global'}" (only global or system)`,
      );
    }
  }

  // Check for path traversal in allowedPaths and deniedPaths
  const allowedPaths = Array.isArray(bash.allowedPaths) ? (bash.allowedPaths as string[]) : [];
  const deniedPaths = Array.isArray(bash.deniedPaths) ? (bash.deniedPaths as string[]) : [];
  const ctx = { agentName, projectRel };
  errors.push(...checkBashPathTraversal(allowedPaths, { ...ctx, fieldName: 'allowedPaths' }));
  errors.push(...checkBashPathTraversal(deniedPaths, { ...ctx, fieldName: 'deniedPaths' }));

  warnings.push(...checkDeniedPathsWarnings(bash, agentName, projectRel));

  return { errors, warnings };
}

interface AgentsDirResult {
  errors: string[];
  warnings: string[];
}

interface CheckKnownSkillsOptions {
  raw: Record<string, unknown>;
  agentName: string;
  projectRel: string;
  opts?: ValidatorOptions;
}

function checkKnownSkills(options: CheckKnownSkillsOptions): string[] {
  const { raw, agentName, projectRel, opts } = options;
  if (!opts?.knownSkills) return [];
  const errors: string[] = [];
  const skills = Array.isArray(raw.skills) ? (raw.skills as string[]) : [];
  for (const skill of skills) {
    if (!opts.knownSkills.has(skill)) {
      errors.push(
        `Agent "${agentName}" in "${projectRel || '_global'}" references unknown skill "${skill}"`,
      );
    }
  }
  return errors;
}

interface ValidateAgentFileOptions {
  filePath: string;
  entryName: string;
  projectRel: string;
  seenAgentNames: Set<string>;
  opts?: ValidatorOptions;
  optional?: boolean;
}

async function validateAgentFile(options: ValidateAgentFileOptions): Promise<AgentsDirResult> {
  const { filePath, entryName, projectRel, seenAgentNames, opts } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const content = await readFile(filePath, 'utf-8');
    const raw = yamlLoad(content) as Record<string, unknown>;
    const parsed = AgentYamlSchema.parse(raw);

    if (seenAgentNames.has(parsed.name)) {
      errors.push(`Duplicate agent name "${parsed.name}" in project "${projectRel || '_global'}"`);
    } else {
      seenAgentNames.add(parsed.name);
    }

    const bashResult = checkBashAccess(raw, parsed.name, projectRel);
    errors.push(...bashResult.errors);
    warnings.push(...bashResult.warnings);

    errors.push(...checkKnownSkills({ raw, agentName: parsed.name, projectRel, opts }));
  } catch (err) {
    if (options.optional && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { errors, warnings };
    }
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Invalid agent YAML in ${projectRel || '_global'}/${entryName}: ${msg}`);
  }

  return { errors, warnings };
}

interface ValidateAgentsDirOptions {
  agentsDir: string;
  projectRel: string;
  seenAgentNames: Set<string>;
  opts?: ValidatorOptions;
}

async function validateAgentsDir(options: ValidateAgentsDirOptions): Promise<AgentsDirResult> {
  const { agentsDir, projectRel, seenAgentNames, opts } = options;
  const errors: string[] = [];
  const warnings: string[] = [];
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`Cannot read agent definitions ${agentsDir}: ${String(error)}`);
    }
    return { errors, warnings };
  }

  const candidates = entries.flatMap((entry) => {
    if (entry.isDirectory()) return [{ name: join(entry.name, 'agent.yaml'), optional: true }];
    if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      return [{ name: entry.name, optional: false }];
    }
    return [];
  });

  for (const entry of candidates) {
    const fileResult = await validateAgentFile({
      filePath: join(agentsDir, entry.name),
      entryName: entry.name,
      projectRel,
      seenAgentNames,
      opts,
      optional: entry.optional,
    });
    errors.push(...fileResult.errors);
    warnings.push(...fileResult.warnings);
  }

  return { errors, warnings };
}

interface ValidateContext {
  projectsDir: string;
  errors: string[];
  warnings: string[];
  opts?: ValidatorOptions;
  projectIds: Map<string, string>;
}

function validateProjectIdentity(id: string | undefined, rel: string, ctx: ValidateContext): void {
  if (!rel) return;
  const isSystem = rel === 'system';
  const effectiveId = id ?? (isSystem ? META_PROJECT_ID : rel);
  if (
    (isSystem && effectiveId !== META_PROJECT_ID) ||
    (!isSystem && effectiveId === META_PROJECT_ID)
  ) {
    ctx.errors.push(`System project identity conflicts at ${rel}/context.md`);
    return;
  }
  const previous = ctx.projectIds.get(effectiveId);
  if (previous) {
    ctx.errors.push(`Duplicate project identity ${effectiveId} in ${previous} and ${rel}`);
  } else {
    ctx.projectIds.set(effectiveId, rel);
  }
}

async function validateProjectContext(
  dirPath: string,
  isRoot: boolean,
  ctx: ValidateContext,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(dirPath, 'context.md'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.errors.push(
        `Cannot read project context ${relative(ctx.projectsDir, dirPath) || '_global'}: ${String(error)}`,
      );
    }
    return isRoot;
  }
  try {
    const definition = readProjectDefinition(raw);
    validateProjectIdentity(definition.metadata?.id, relative(ctx.projectsDir, dirPath), ctx);
  } catch (error) {
    ctx.errors.push(
      `Invalid project context ${relative(ctx.projectsDir, dirPath) || '_global'}/context.md: ${String(error)}`,
    );
  }
  return true;
}

async function getSubdirectories(dirPath: string, ctx: ValidateContext): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !shouldSkipDir(e.name))
      .map((e) => join(dirPath, e.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ctx.errors.push(`Cannot enumerate project directory ${dirPath}: ${String(error)}`);
    }
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`Cannot read template definitions ${templatesDir}: ${String(error)}`);
    }
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

  if (rel === '_global') {
    ctx.errors.push('The _global project path is reserved');
    return;
  }

  if (!isRoot && depth > MAX_DEPTH) {
    ctx.errors.push(`Project nested too deep (>${MAX_DEPTH} levels): ${rel}`);
    return;
  }

  if (!(await validateProjectContext(dirPath, isRoot, ctx))) return;

  const agentNames = new Set<string>();
  const agentResult = await validateAgentsDir({
    agentsDir: join(dirPath, 'agents'),
    projectRel: rel,
    seenAgentNames: agentNames,
    opts: ctx.opts,
  });
  ctx.errors.push(...agentResult.errors);
  ctx.warnings.push(...agentResult.warnings);

  const scheduleErrors = await validateYamlFiles({
    dir: join(dirPath, 'schedules'),
    schema: ScheduleYamlSchema,
    kind: 'schedule',
    projectRel: rel || '_global',
  });
  ctx.errors.push(...scheduleErrors);

  const templateErrors = await validateTemplatesDir(join(dirPath, 'templates'), rel || '_global');
  ctx.errors.push(...templateErrors);

  const subdirs = await getSubdirectories(dirPath, ctx);
  for (const subdir of subdirs) {
    await validateDir(subdir, depth + 1, ctx);
  }
}

export async function validateProjects(
  projectsDir: string,
  opts?: ValidatorOptions,
): Promise<{ errors: string[]; warnings: string[] }> {
  const ctx: ValidateContext = {
    projectsDir,
    errors: [],
    warnings: [],
    projectIds: new Map(),
    opts,
  };

  await validateDir(projectsDir, 0, ctx);
  return { errors: ctx.errors, warnings: ctx.warnings };
}
