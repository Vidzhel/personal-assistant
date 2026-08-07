import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import yaml from 'js-yaml';
const { dump } = yaml;

import {
  createLogger,
  AgentYamlSchema,
  ScheduleYamlSchema,
  TaskTemplateSchema,
  SkillConfigSchema,
} from '@raven/shared';
import type { AgentYaml, ScheduleYaml, TaskTemplate, SkillConfig } from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { AgentYamlStore } from '../project-registry/agent-yaml-store.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';

const log = createLogger('scaffolding-api');

const LINE_WIDTH = 120;
const DOMAIN_RE = /^[a-z][a-z0-9-]*$/;

// ── Input types ──────────────────────────────────────────────────────────

export interface ScaffoldProjectInput {
  path: string;
  displayName?: string;
  description?: string;
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
  createProject(input: ScaffoldProjectInput): Promise<string>;
  createAgent(input: ScaffoldAgentInput): Promise<string>;
  createTemplate(input: ScaffoldTemplateInput): Promise<string>;
  createSchedule(input: ScaffoldScheduleInput): Promise<string>;
  createSkill(input: ScaffoldSkillInput): Promise<string>;
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

// eslint-disable-next-line max-lines-per-function -- factory with project/agent/template/schedule/skill creation methods
export function createScaffoldingApi(deps: ScaffoldingDeps): ScaffoldingApi {
  const { projectsDir, projectRegistry, agentYamlStore: _agentYamlStore } = deps;

  function projectDirFor(relativePath: string): string {
    return resolveProjectDir(projectsDir, relativePath);
  }

  async function createProject(input: ScaffoldProjectInput): Promise<string> {
    const projectDir = projectDirFor(input.path);
    await mkdir(projectDir, { recursive: true });

    const title = input.displayName ?? input.path;
    const body = input.description ?? '';
    const contextMd = `# ${title}\n\n${body}\n`.trimEnd() + '\n';

    await writeFile(join(projectDir, 'context.md'), contextMd, 'utf-8');
    log.info(`Created project: ${input.path}`);
    return input.path;
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
    const projectDir = projectDirFor(input.projectPath);
    const schedulesDir = join(projectDir, 'schedules');
    await mkdir(schedulesDir, { recursive: true });

    const filePath = join(schedulesDir, `${validated.name}.yaml`);
    const yaml = dump(validated, { lineWidth: LINE_WIDTH });
    await writeFile(filePath, yaml, 'utf-8');

    log.info(`Created schedule: ${validated.name} in ${input.projectPath || '_global'}`);
    return validated.name;
  }

  async function createSkill(input: ScaffoldSkillInput): Promise<string> {
    if (!DOMAIN_RE.test(input.domain)) {
      throw new Error(`Skill domain must be lowercase kebab-case: ${input.domain}`);
    }
    if (!deps.capabilityLibrary || !deps.libraryDir) {
      throw new Error('createSkill requires capabilityLibrary + libraryDir to be configured');
    }

    const validated = SkillConfigSchema.parse(input.skill);
    for (const action of validated.actions) {
      if (action.defaultTier === 'red') {
        throw new Error(
          `Tool-created skills cannot set action "${action.name}" to red tier — ` +
            `red requires the owner to edit library/skills/${input.domain}/${validated.name}/config.json directly`,
        );
      }
    }
    for (const mcpRef of validated.mcps) {
      if (!deps.capabilityLibrary.getMcp(mcpRef)) {
        throw new Error(`MCP reference "${mcpRef}" not found in library/mcps/`);
      }
    }

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
    if (!(await pathExists(domainIndexPath))) {
      await writeFile(
        domainIndexPath,
        `# ${domainTitle(input.domain)} Skills\n\n- **${validated.name}/** — ${validated.description}\n`,
        'utf-8',
      );
    }

    log.info(`Created skill: ${input.domain}/${validated.name}`);
    return validated.name;
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
    createAgent,
    createTemplate,
    createSchedule,
    createSkill,
    scaffoldDomain,
  };
}
