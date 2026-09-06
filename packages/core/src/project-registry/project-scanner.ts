import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import yaml from 'js-yaml';
import { parse as parseWorkspaceYaml } from 'yaml';
const { load: yamlLoad } = yaml;

import {
  createLogger,
  AgentYamlSchema,
  ProjectWorkspaceSchema,
  ScheduleYamlSchema,
  META_PROJECT_ID,
} from '@raven/shared';
import type {
  AgentYaml,
  ScheduleYaml,
  ProjectNode,
  ProjectIndex,
  ProjectMetadata,
} from '@raven/shared';
import { readProjectTextFile } from '../project-manager/project-file-read.ts';
import { readProjectDefinition } from './project-definition.ts';
import { errorMessage, validateScheduleTiming } from '../diagnostics/definition-diagnostics.ts';
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';

const log = createLogger('project-scanner');

const SKIP_DIRS = new Set([
  'agents',
  'templates',
  'schedules',
  'tasks',
  'memory',
  'files',
  'node_modules',
  '.git',
]);
const MAX_WORKSPACE_BYTES = 1_048_576;
const MAX_CONTEXT_BYTES = 1_048_576;

export interface ProjectScanOptions {
  knownSkills?: ReadonlySet<string>;
}

export interface ScannedProjectIndex extends ProjectIndex {
  diagnostics: DefinitionDiagnostic[];
  invalidProjectPaths: string[];
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function addDiagnostic(
  diagnostics: DefinitionDiagnostic[],
  diagnostic: Omit<DefinitionDiagnostic, 'message'> & { message: string },
): void {
  diagnostics.push(diagnostic);
}

function workspaceDiagnostic(
  rel: string,
  message: string,
): Omit<DefinitionDiagnostic, 'message'> & { message: string } {
  return {
    source: 'project',
    path: `${rel || '.'}/project.yaml`,
    code: 'invalid-project-workspace',
    message,
    severity: 'error',
  };
}

function validateWorkspaceManifest(
  dirPath: string,
  rel: string,
  diagnostics: DefinitionDiagnostic[],
): boolean {
  const filePath = join(dirPath, 'project.yaml');
  try {
    const raw = readProjectTextFile(filePath, MAX_WORKSPACE_BYTES);
    if (raw === undefined) return true;
    ProjectWorkspaceSchema.parse(parseWorkspaceYaml(raw));
    return true;
  } catch (error) {
    addDiagnostic(
      diagnostics,
      workspaceDiagnostic(rel, `Invalid workspace manifest: ${errorMessage(error)}`),
    );
    log.warn(`Skipping invalid workspace manifest: ${filePath}`);
    return false;
  }
}

interface KnownSkillValidation {
  metadata?: ProjectMetadata;
  rel: string;
  options: ProjectScanOptions;
  diagnostics: DefinitionDiagnostic[];
}

function validateKnownSkills(context: KnownSkillValidation): void {
  const { metadata, rel, options, diagnostics } = context;
  if (!metadata?.skills || !options.knownSkills) return;
  for (const skill of metadata.skills) {
    if (!options.knownSkills.has(skill)) {
      addDiagnostic(diagnostics, {
        source: 'project',
        path: `${rel || '.'}/context.md`,
        code: 'unknown-skill-reference',
        message: `Project references unknown skill "${skill}"`,
        severity: 'error',
      });
    }
  }
}

interface DefinitionFilesContext {
  rootDir: string;
  diagnostics: DefinitionDiagnostic[];
}

async function listAgentCandidates(
  agentsDir: string,
  context: DefinitionFilesContext,
): Promise<string[]> {
  try {
    const dirEntries = await readdir(agentsDir, { withFileTypes: true });
    return dirEntries.flatMap((entry) => {
      if (entry.isDirectory()) return [join(entry.name, 'agent.yaml')];
      if (entry.isFile() && /\.ya?ml$/.test(entry.name)) return [entry.name];
      return [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    addDiagnostic(context.diagnostics, {
      source: 'agent',
      path: relativePath(context.rootDir, agentsDir),
      code: 'agent-directory-unreadable',
      message: `Cannot read agent definitions: ${errorMessage(error)}`,
      severity: 'error',
    });
    return [];
  }
}

async function parseAgent(
  filePath: string,
  options: ProjectScanOptions,
  context: DefinitionFilesContext,
): Promise<AgentYaml | undefined> {
  try {
    const parsed = AgentYamlSchema.parse(yamlLoad(await readFile(filePath, 'utf-8')));
    for (const skill of parsed.skills) {
      if (options.knownSkills && !options.knownSkills.has(skill)) {
        addDiagnostic(context.diagnostics, {
          source: 'agent',
          path: relativePath(context.rootDir, filePath),
          code: 'unknown-skill-reference',
          message: `Agent "${parsed.name}" references unknown skill "${skill}"`,
          severity: 'error',
        });
      }
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && filePath.endsWith(`${sep}agent.yaml`))
      return undefined;
    addDiagnostic(context.diagnostics, {
      source: 'agent',
      path: relativePath(context.rootDir, filePath),
      code: 'invalid-agent-definition',
      message: `Invalid agent YAML: ${errorMessage(error)}`,
      severity: 'error',
    });
    log.warn(`Skipping invalid agent YAML: ${filePath}`);
    return undefined;
  }
}

async function loadAgentYamls(
  agentsDir: string,
  context: DefinitionFilesContext,
  options: ProjectScanOptions,
): Promise<AgentYaml[]> {
  const candidates = await listAgentCandidates(agentsDir, context);
  const agents = await Promise.all(
    candidates.map((name) => parseAgent(join(agentsDir, name), options, context)),
  );
  return agents.filter((agent): agent is AgentYaml => agent !== undefined);
}

async function listScheduleCandidates(
  schedulesDir: string,
  context: DefinitionFilesContext,
): Promise<string[]> {
  try {
    const dirEntries = await readdir(schedulesDir, { withFileTypes: true });
    return dirEntries
      .filter((e) => e.isFile() && (e.name.endsWith('.yaml') || e.name.endsWith('.yml')))
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    addDiagnostic(context.diagnostics, {
      source: 'schedule',
      path: relativePath(context.rootDir, schedulesDir),
      code: 'schedule-directory-unreadable',
      message: `Cannot read schedule definitions: ${errorMessage(error)}`,
      severity: 'error',
    });
    return [];
  }
}

async function parseSchedule(
  filePath: string,
  context: DefinitionFilesContext,
): Promise<ScheduleYaml | undefined> {
  try {
    const parsed = ScheduleYamlSchema.parse(yamlLoad(await readFile(filePath, 'utf-8')));
    const timingError = validateScheduleTiming(parsed.cron, parsed.timezone);
    if (timingError) {
      addDiagnostic(context.diagnostics, {
        source: 'schedule',
        path: relativePath(context.rootDir, filePath),
        code: 'invalid-schedule-timing',
        message: `Invalid schedule cron/timezone: ${timingError}`,
        severity: 'error',
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    addDiagnostic(context.diagnostics, {
      source: 'schedule',
      path: relativePath(context.rootDir, filePath),
      code: 'invalid-schedule-definition',
      message: `Invalid schedule YAML: ${errorMessage(error)}`,
      severity: 'error',
    });
    log.warn(`Skipping invalid schedule YAML: ${filePath}`);
    return undefined;
  }
}

async function loadScheduleYamls(
  schedulesDir: string,
  context: DefinitionFilesContext,
): Promise<ScheduleYaml[]> {
  const candidates = await listScheduleCandidates(schedulesDir, context);
  const schedules = await Promise.all(
    candidates.map((name) => parseSchedule(join(schedulesDir, name), context)),
  );
  return schedules.filter((schedule): schedule is ScheduleYaml => schedule !== undefined);
}

interface ScanContext {
  projectsDir: string;
  projects: Map<string, ProjectNode>;
  options: ProjectScanOptions;
  diagnostics: DefinitionDiagnostic[];
  invalidProjectPaths: Set<string>;
  projectIdentities: Map<string, string>;
}

interface DefinitionReadRequest {
  dirPath: string;
  rel: string;
  ctx: ScanContext;
  requireContext: boolean;
}

interface ContextAnchorRequest {
  id: string;
  rel: string;
  contextMd: string | null;
  ctx: ScanContext;
  requireContext: boolean;
}

interface ScanDirectoryRequest {
  dirPath: string;
  parentId: string | null;
  ctx: ScanContext;
  requireContext: boolean;
}

function deriveProjectName(rel: string): string {
  if (rel === '_global') throw new Error('The _global project path is reserved');
  const parts = rel.split('/');
  return parts[parts.length - 1] ?? '_global';
}

async function scanSubdirectories(dirPath: string, id: string, ctx: ScanContext): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && id !== '_global') return;
    if (id === '_global') throw error;
    const path = relativePath(ctx.projectsDir, dirPath);
    ctx.invalidProjectPaths.add(path);
    addDiagnostic(ctx.diagnostics, {
      source: 'project',
      path,
      code: 'project-directory-unreadable',
      message: `Cannot enumerate project directory: ${errorMessage(error)}`,
      severity: 'error',
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    const childPath = join(dirPath, entry.name);
    const marked = await hasWorkspaceMarker(childPath);
    if (id !== '_global' && !marked) continue;
    await scanDir({ dirPath: childPath, parentId: id, ctx, requireContext: marked });
  }
}

async function hasWorkspaceMarker(dirPath: string): Promise<boolean> {
  try {
    await lstat(join(dirPath, 'project.yaml'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function metadataFields(
  metadata?: ProjectMetadata,
): Pick<ProjectNode, 'metadata' | 'displayName' | 'description' | 'systemAccess'> {
  return {
    metadata,
    displayName: metadata?.displayName,
    description: metadata?.description,
    systemAccess: metadata?.systemAccess ?? 'none',
  };
}

function reportMissingContext(rel: string, ctx: ScanContext): void {
  ctx.invalidProjectPaths.add(rel);
  addDiagnostic(ctx.diagnostics, {
    source: 'project',
    path: `${rel}/context.md`,
    code: 'missing-project-context',
    message: 'Project is missing its context.md anchor',
    severity: 'error',
  });
}

function hasContextAnchor({
  id,
  rel,
  contextMd,
  ctx,
  requireContext,
}: ContextAnchorRequest): boolean {
  if (id === '_global' || contextMd !== null) return true;
  if (
    id !== '_global' &&
    requireContext &&
    !ctx.diagnostics.some((diagnostic) => diagnostic.path === `${rel}/context.md`)
  ) {
    reportMissingContext(rel, ctx);
  }
  return false;
}

async function readDefinition({
  dirPath,
  rel,
  ctx,
  requireContext,
}: DefinitionReadRequest): Promise<
  { contextMd: string; definition: ReturnType<typeof readProjectDefinition> } | undefined
> {
  const id = rel || '_global';
  if (id !== '_global' && !validateWorkspaceManifest(dirPath, rel, ctx.diagnostics)) {
    ctx.invalidProjectPaths.add(rel);
    return undefined;
  }
  const contextMd = await readProjectContext(dirPath, rel, ctx);
  if (!hasContextAnchor({ id, rel, contextMd, ctx, requireContext })) return undefined;

  try {
    const definition = readProjectDefinition(contextMd ?? '');
    validateKnownSkills({
      metadata: definition.metadata,
      rel,
      options: ctx.options,
      diagnostics: ctx.diagnostics,
    });
    return { contextMd: contextMd ?? '', definition };
  } catch (error) {
    if (id === '_global') throw error;
    ctx.invalidProjectPaths.add(rel);
    addDiagnostic(ctx.diagnostics, {
      source: 'project',
      path: `${rel}/context.md`,
      code: 'invalid-project-context',
      message: `Invalid project context: ${errorMessage(error)}`,
      severity: 'error',
    });
    return undefined;
  }
}

async function readProjectContext(
  dirPath: string,
  rel: string,
  ctx: ScanContext,
): Promise<string | null> {
  const id = rel || '_global';
  try {
    const contextMd = readProjectTextFile(join(dirPath, 'context.md'), MAX_CONTEXT_BYTES);
    if (id !== '_global' && contextMd === undefined) return null;
    return contextMd ?? null;
  } catch (error) {
    if (id === '_global') throw error;
    ctx.invalidProjectPaths.add(rel);
    addDiagnostic(ctx.diagnostics, {
      source: 'project',
      path: `${rel}/context.md`,
      code: 'project-context-unreadable',
      message: `Cannot read project context: ${errorMessage(error)}`,
      severity: 'error',
    });
    return null;
  }
}

interface NodeRegistration {
  dirPath: string;
  parentId: string | null;
  definition: ReturnType<typeof readProjectDefinition>;
  ctx: ScanContext;
  agents: AgentYaml[];
  schedules: ScheduleYaml[];
}

function hasSystemIdentityConflict(context: {
  registration: NodeRegistration;
  id: string;
  name: string;
  configuredId?: string;
}): boolean {
  const { registration, id, name, configuredId } = context;
  const isMeta = registration.parentId === '_global' && name === 'system';
  if (
    (isMeta && configuredId && configuredId !== META_PROJECT_ID) ||
    (!isMeta && configuredId === META_PROJECT_ID)
  ) {
    registration.ctx.invalidProjectPaths.add(id);
    addDiagnostic(registration.ctx.diagnostics, {
      source: 'project',
      path: `${id}/context.md`,
      code: 'system-identity-conflict',
      message: `System project identity conflicts at ${id}/context.md`,
      severity: 'error',
    });
    return true;
  }
  return false;
}

function projectIdentity(
  registration: NodeRegistration,
  id: string,
  name: string,
): string | undefined {
  if (id === '_global') return '_global';
  const configuredId = registration.definition.metadata?.id;
  if (hasSystemIdentityConflict({ registration, id, name, configuredId })) return undefined;
  return registration.parentId === '_global' && name === 'system'
    ? META_PROJECT_ID
    : (configuredId ?? id);
}

function registerProjectIdentity(
  registration: NodeRegistration,
  id: string,
  name: string,
): boolean {
  const identity = projectIdentity(registration, id, name);
  if (!identity) return false;
  const previousPath = registration.ctx.projectIdentities.get(identity);
  if (!previousPath || previousPath === id) {
    registration.ctx.projectIdentities.set(identity, id);
    return true;
  }
  for (const path of [previousPath, id]) {
    registration.ctx.invalidProjectPaths.add(path);
    addDiagnostic(registration.ctx.diagnostics, {
      source: 'project',
      path: `${path}/context.md`,
      code: 'duplicate-project-identity',
      message: `Project identity "${identity}" is also defined at ${previousPath === path ? id : previousPath}`,
      severity: 'error',
    });
  }
  return false;
}

function registerNode(registration: NodeRegistration): ProjectNode | undefined {
  const { dirPath, parentId, definition, ctx, agents, schedules } = registration;
  const rel = relative(ctx.projectsDir, dirPath);
  const id = rel || '_global';
  const name = rel ? deriveProjectName(rel) : '_global';
  if (!registerProjectIdentity(registration, id, name)) return undefined;
  const node: ProjectNode = {
    id,
    name,
    ...metadataFields(definition.metadata),
    path: dirPath,
    relativePath: rel || '.',
    parentId,
    isMeta: parentId === '_global' && name === 'system',
    contextMd: definition.body,
    agents,
    schedules,
    children: [],
  };
  ctx.projects.set(id, node);
  if (parentId !== null) ctx.projects.get(parentId)?.children.push(id);
  return node;
}

async function scanDir({
  dirPath,
  parentId,
  ctx,
  requireContext,
}: ScanDirectoryRequest): Promise<void> {
  const rel = relative(ctx.projectsDir, dirPath);
  const result = await readDefinition({
    dirPath,
    rel,
    ctx,
    requireContext,
  });
  if (!result) return;

  const agents = await loadAgentYamls(
    join(dirPath, 'agents'),
    { rootDir: ctx.projectsDir, diagnostics: ctx.diagnostics },
    ctx.options,
  );
  const schedules = await loadScheduleYamls(join(dirPath, 'schedules'), {
    rootDir: ctx.projectsDir,
    diagnostics: ctx.diagnostics,
  });
  const node = registerNode({
    dirPath,
    parentId,
    definition: result.definition,
    ctx,
    agents,
    schedules,
  });
  if (!node) return;
  await scanSubdirectories(dirPath, node.id, ctx);
}

export async function scanProjects(
  projectsDir: string,
  options: ProjectScanOptions = {},
): Promise<ScannedProjectIndex> {
  await stat(projectsDir);
  const ctx: ScanContext = {
    projectsDir,
    projects: new Map<string, ProjectNode>(),
    options,
    diagnostics: [],
    invalidProjectPaths: new Set(),
    projectIdentities: new Map(),
  };

  await scanDir({ dirPath: projectsDir, parentId: null, ctx, requireContext: false });

  const rootProjects = [...ctx.projects.values()]
    .filter((p) => p.parentId === '_global')
    .map((p) => p.id);

  return {
    projects: ctx.projects,
    rootProjects,
    diagnostics: ctx.diagnostics,
    invalidProjectPaths: [...ctx.invalidProjectPaths],
  };
}
