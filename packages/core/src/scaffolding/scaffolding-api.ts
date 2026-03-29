import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import yaml from 'js-yaml';
const { dump } = yaml;

import {
  createLogger,
  AgentYamlSchema,
  ScheduleYamlSchema,
  TaskTemplateSchema,
} from '@raven/shared';
import type { AgentYaml, ScheduleYaml, TaskTemplate } from '@raven/shared';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { AgentYamlStore } from '../project-registry/agent-yaml-store.ts';

const log = createLogger('scaffolding-api');

const LINE_WIDTH = 120;

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
}

// ── Public API type ──────────────────────────────────────────────────────

export interface ScaffoldingApi {
  createProject(input: ScaffoldProjectInput): Promise<string>;
  createAgent(input: ScaffoldAgentInput): Promise<string>;
  createTemplate(input: ScaffoldTemplateInput): Promise<string>;
  createSchedule(input: ScaffoldScheduleInput): Promise<string>;
  scaffoldDomain(plan: ScaffoldPlan): Promise<ScaffoldResult>;
}

// ── Factory ──────────────────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function -- factory with project/agent/template/schedule creation methods
export function createScaffoldingApi(deps: ScaffoldingDeps): ScaffoldingApi {
  const { projectsDir, projectRegistry, agentYamlStore: _agentYamlStore } = deps;

  function resolveProjectDir(relativePath: string): string {
    return relativePath === '' ? projectsDir : join(projectsDir, relativePath);
  }

  async function createProject(input: ScaffoldProjectInput): Promise<string> {
    const projectDir = resolveProjectDir(input.path);
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
    const projectDir = resolveProjectDir(input.projectPath);
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
    const projectDir = resolveProjectDir(input.projectPath);
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
    const projectDir = resolveProjectDir(input.projectPath);
    const schedulesDir = join(projectDir, 'schedules');
    await mkdir(schedulesDir, { recursive: true });

    const filePath = join(schedulesDir, `${validated.name}.yaml`);
    const yaml = dump(validated, { lineWidth: LINE_WIDTH });
    await writeFile(filePath, yaml, 'utf-8');

    log.info(`Created schedule: ${validated.name} in ${input.projectPath || '_global'}`);
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

  return { createProject, createAgent, createTemplate, createSchedule, scaffoldDomain };
}
