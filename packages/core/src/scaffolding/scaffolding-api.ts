import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

import yaml from 'js-yaml';
const { dump } = yaml;

import { Cron } from 'croner';

import {
  createLogger,
  gitAutoCommit,
  AgentYamlSchema,
  ScheduleYamlSchema,
  TaskTemplateSchema,
  SkillConfigSchema,
} from '@raven/shared';
import type { AgentYaml, ScheduleYaml, TaskTemplate, SkillConfig } from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { AgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { createProjectDefinition } from '../project-manager/create-project-definition.ts';
import { withProjectMutation } from '../project-manager/project-mutation.ts';

const log = createLogger('scaffolding-api');

const LINE_WIDTH = 120;
const DOMAIN_RE = /^[a-z][a-z0-9-]*$/;

// ── Input types ──────────────────────────────────────────────────────────

export interface ScaffoldProjectInput {
  path: string;
  id?: string;
  displayName?: string;
  description?: string;
  skills?: string[];
  systemPrompt?: string;
  systemAccess?: 'none' | 'read' | 'read-write';
}

export interface ScaffoldAgentInput {
  projectPath: string;
  agent: AgentYaml;
}

export interface ScaffoldTemplateInput {
  projectPath: string;
  template: TaskTemplate;
}

export interface ScaffoldScheduleInput {
  projectPath: string;
  schedule: ScheduleYaml;
}

export interface ScaffoldSkillInput {
  /** Domain/category folder under library/skills/, e.g. "productivity". */
  domain: string;
  skill: SkillConfig;
  /** Body of skill.md — instructions the agent reads when using this skill. */
  skillMd: string;
}

export interface CreateSkillResult {
  name: string;
  /** Set only when this call also created a brand-new domain folder's
   * _index.md (library-validator.ts requires one on any directory that has
   * subdirectories but no config.json of its own). Callers must include
   * this path in their git-commit pathspec alongside the skill dir, or the
   * new domain's required index file ships outside the commit that
   * introduced it — see scaffold-and-activate.ts's activateSkill. */
  indexMdPath?: string;
}

export interface ScaffoldPlan {
  projects: ScaffoldProjectInput[];
  agents: ScaffoldAgentInput[];
  templates: ScaffoldTemplateInput[];
  schedules: ScaffoldScheduleInput[];
}

export interface ScaffoldResult {
  projectsCreated: string[];
  agentsCreated: string[];
  templatesCreated: string[];
  schedulesCreated: string[];
  errors: string[];
}

// ── Dependencies ─────────────────────────────────────────────────────────

export interface ScaffoldingDeps {
  projectsDir: string;
  projectRegistry: ProjectRegistry;
  syncProjects?: () => void;
  agentYamlStore: AgentYamlStore;
  /** Needed only by createSkill (validates mcp refs, reloaded by the caller
   * after a write — see scaffold-and-activate.ts). Optional so existing
   * callers that never create skills don't need to wire it. */
  capabilityLibrary?: CapabilityLibrary;
  /** Needed only by createSkill — the library/ directory root. */
  libraryDir?: string;
}

// ── Public API type ──────────────────────────────────────────────────────

export interface ScaffoldingApi {
  createProject(input: ScaffoldProjectInput, options?: { system?: boolean }): Promise<string>;
  createAgent(input: ScaffoldAgentInput): Promise<string>;
  createTemplate(input: ScaffoldTemplateInput): Promise<string>;
  createSchedule(input: ScaffoldScheduleInput): Promise<string>;
  createSkill(input: ScaffoldSkillInput): Promise<CreateSkillResult>;
  scaffoldDomain(plan: ScaffoldPlan): Promise<ScaffoldResult>;
}

// ── Factory ──────────────────────────────────────────────────────────────

/** Exported so callers that need the exact on-disk path of a scaffolded
 * artifact (e.g. scaffold-and-activate.ts, to git-add the right file after
 * writing) can recompute it without duplicating the join logic. */
export function resolveProjectDir(projectsDir: string, relativePath: string): string {
  return relativePath === '' ? projectsDir : join(projectsDir, relativePath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function domainTitle(domain: string): string {
  return domain
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Traversal guard shared by every artifact-creating function via
 * projectDirFor below (F3): '' is the one allowed non-relative value (it
 * means "global scope" — see resolveProjectDir), everything else must be a
 * plain relative path with no ".." segment. Chat hardcodes projectPath:'' and
 * kebab-validates project names, so this is unreachable from chat — but the
 * REST scaffold routes and scaffoldDomain forward owner/caller-supplied
 * path/projectPath values straight through, so a value like
 * "../../../etc" must be rejected here rather than silently resolving
 * outside projectsDir. */
function assertSafeRelativePath(relativePath: string, label: string): void {
  if (relativePath === '') return;
  const hasDotDotSegment = relativePath.split(/[/\\]+/).some((segment) => segment === '..');
  if (hasDotDotSegment || isAbsolute(relativePath) || relativePath.startsWith('/')) {
    throw new Error(
      `Invalid ${label}: must be a relative path with no ".." segments (got "${relativePath}")`,
    );
  }
}

/** Throwaway construction to force croner to validate the cron pattern and
 * IANA timezone SYNCHRONOUSLY, before anything is written to disk (F1).
 * Croner throws at construction for a malformed pattern, and at nextRun()
 * for an invalid timezone (see schedule-engine.ts's startEntry, which hits
 * the exact same throw shape once a function callback is supplied) — no
 * callback is passed here, so no timer is ever armed by this check. */
function validateCronSchedule(schedule: ScheduleYaml): void {
  try {
    new Cron(schedule.cron, { timezone: schedule.timezone }).nextRun();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid cron "${schedule.cron}" or timezone "${schedule.timezone}" for schedule "${schedule.name}": ${reason}`,
      { cause: err },
    );
  }
}

/** Split out of createSkill purely to keep that function's cyclomatic
 * complexity under the guardrail — these three checks (domain casing,
 * red-tier cap, mcp-ref existence) are independent validations with no
 * shared state beyond `deps`/`input`/`validated`, already in scope. */
function assertSkillCreatable(
  input: ScaffoldSkillInput,
  validated: SkillConfig,
  deps: ScaffoldingDeps,
): void {
  if (!DOMAIN_RE.test(input.domain)) {
    throw new Error(`Skill domain must be lowercase kebab-case: ${input.domain}`);
  }
  for (const action of validated.actions) {
    if (action.defaultTier === 'red') {
      throw new Error(
        `Tool-created skills cannot set action "${action.name}" to red tier — ` +
          `red requires the owner to edit library/skills/${input.domain}/${validated.name}/config.json directly`,
      );
    }
  }
  for (const mcpRef of validated.mcps) {
    if (!deps.capabilityLibrary?.getMcp(mcpRef)) {
      throw new Error(`MCP reference "${mcpRef}" not found in library/mcps/`);
    }
  }
}

// eslint-disable-next-line max-lines-per-function -- factory with project/agent/template/schedule/skill creation methods
export function createScaffoldingApi(deps: ScaffoldingDeps): ScaffoldingApi {
  const { projectsDir, projectRegistry, agentYamlStore: _agentYamlStore } = deps;

  function projectDirFor(relativePath: string): string {
    assertSafeRelativePath(relativePath, 'project path');
    return resolveProjectDir(projectsDir, relativePath);
  }

  async function createProject(
    input: ScaffoldProjectInput,
    options?: { system?: boolean },
  ): Promise<string> {
    return createProjectDefinition(deps, input, options?.system);
  }

  async function createAgent(input: ScaffoldAgentInput): Promise<string> {
    const validated = AgentYamlSchema.parse(input.agent);
    const projectDir = projectDirFor(input.projectPath);
    const agentsDir = join(projectDir, 'agents');
    await mkdir(agentsDir, { recursive: true });

    const filePath = join(agentsDir, `${validated.name}.yaml`);
    const yaml = dump(validated, { lineWidth: LINE_WIDTH });
    await writeFile(filePath, yaml, 'utf-8');

    log.info(`Created agent: ${validated.name} in ${input.projectPath || '_global'}`);
    return validated.name;
  }

  async function createTemplate(input: ScaffoldTemplateInput): Promise<string> {
    const validated = TaskTemplateSchema.parse(input.template);
    const projectDir = projectDirFor(input.projectPath);
    const templatesDir = join(projectDir, 'templates');
    await mkdir(templatesDir, { recursive: true });

    const filePath = join(templatesDir, `${validated.name}.yaml`);
    const yaml = dump(validated, { lineWidth: LINE_WIDTH });
    await writeFile(filePath, yaml, 'utf-8');

    log.info(`Created template: ${validated.name} in ${input.projectPath || '_global'}`);
    return validated.name;
  }

  async function createSchedule(input: ScaffoldScheduleInput): Promise<string> {
    const validated = ScheduleYamlSchema.parse(input.schedule);
    // F1: validate the cron/timezone BEFORE anything is written — croner
    // throws synchronously on a bad pattern/timezone, and if that throw
    // happened only after the YAML hit disk, the poisoned file would still
    // be there for the next boot's resync to choke on (see
    // schedule-engine.ts's startEntry for the defense-in-depth half of this
    // fix).
    validateCronSchedule(validated);
    const projectDir = projectDirFor(input.projectPath);
    const schedulesDir = join(projectDir, 'schedules');
    await mkdir(schedulesDir, { recursive: true });

    const filePath = join(schedulesDir, `${validated.name}.yaml`);
    const yaml = dump(validated, { lineWidth: LINE_WIDTH });
    await writeFile(filePath, yaml, 'utf-8');

    log.info(`Created schedule: ${validated.name} in ${input.projectPath || '_global'}`);
    return validated.name;
  }

  async function createSkill(input: ScaffoldSkillInput): Promise<CreateSkillResult> {
    if (!deps.capabilityLibrary || !deps.libraryDir) {
      throw new Error('createSkill requires capabilityLibrary + libraryDir to be configured');
    }

    const validated = SkillConfigSchema.parse(input.skill);
    assertSkillCreatable(input, validated, deps);

    const domainDir = join(deps.libraryDir, 'skills', input.domain);
    const skillDir = join(domainDir, validated.name);
    await mkdir(skillDir, { recursive: true });

    await writeFile(
      join(skillDir, 'config.json'),
      `${JSON.stringify(validated, null, 2)}\n`,
      'utf-8',
    );
    const skillMd = input.skillMd.endsWith('\n') ? input.skillMd : `${input.skillMd}\n`;
    await writeFile(join(skillDir, 'skill.md'), skillMd, 'utf-8');

    // library-validator.ts requires _index.md on any directory that has
    // subdirectories but no config.json of its own — a brand new domain
    // folder needs one or `npm run validate:library` fails.
    const domainIndexPath = join(domainDir, '_index.md');
    let indexMdPath: string | undefined;
    if (!(await pathExists(domainIndexPath))) {
      await writeFile(
        domainIndexPath,
        `# ${domainTitle(input.domain)} Skills\n\n- **${validated.name}/** — ${validated.description}\n`,
        'utf-8',
      );
      indexMdPath = domainIndexPath;
    }

    log.info(`Created skill: ${input.domain}/${validated.name}`);
    return { name: validated.name, ...(indexMdPath !== undefined && { indexMdPath }) };
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- sequential scaffolding with error collection
  async function scaffoldDomain(plan: ScaffoldPlan): Promise<ScaffoldResult> {
    const result: ScaffoldResult = {
      projectsCreated: [],
      agentsCreated: [],
      templatesCreated: [],
      schedulesCreated: [],
      errors: [],
    };

    // Projects first
    for (const p of plan.projects) {
      try {
        result.projectsCreated.push(await createProject(p));
        await gitAutoCommit(
          [join(projectDirFor(p.path), 'context.md')],
          `feat(project): scaffold ${p.path}`,
        );
      } catch (err) {
        result.errors.push(
          `project ${p.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Agents
    for (const a of plan.agents) {
      try {
        result.agentsCreated.push(await createAgent(a));
      } catch (err) {
        const name = a.agent?.name ?? 'unknown';
        result.errors.push(`agent ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Templates
    for (const t of plan.templates) {
      try {
        result.templatesCreated.push(await createTemplate(t));
      } catch (err) {
        const name = t.template?.name ?? 'unknown';
        result.errors.push(`template ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Schedules
    for (const s of plan.schedules) {
      try {
        result.schedulesCreated.push(await createSchedule(s));
      } catch (err) {
        const name = s.schedule?.name ?? 'unknown';
        result.errors.push(`schedule ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Reload project registry to pick up new filesystem structure
    try {
      await projectRegistry.load(projectsDir);
      log.info('Project registry reloaded after scaffolding');
    } catch (err) {
      result.errors.push(`registry reload: ${err instanceof Error ? err.message : String(err)}`);
    }

    log.info(
      `Scaffolding complete: ${String(result.projectsCreated.length)} projects, ${String(result.agentsCreated.length)} agents, ${String(result.templatesCreated.length)} templates, ${String(result.schedulesCreated.length)} schedules, ${String(result.errors.length)} errors`,
    );

    return result;
  }

  return {
    createProject,
    createAgent: (input) => withProjectMutation(projectsDir, () => createAgent(input)),
    createTemplate: (input) => withProjectMutation(projectsDir, () => createTemplate(input)),
    createSchedule: (input) => withProjectMutation(projectsDir, () => createSchedule(input)),
    createSkill,
    scaffoldDomain: (plan) => withProjectMutation(projectsDir, () => scaffoldDomain(plan)),
  };
}
