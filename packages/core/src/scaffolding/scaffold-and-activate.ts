import { join } from 'node:path';
import { createLogger, gitAutoCommit } from '@raven/shared';
import {
  resolveProjectDir,
  type ScaffoldingApi,
  type ScaffoldProjectInput,
  type ScaffoldAgentInput,
  type ScaffoldTemplateInput,
  type ScaffoldScheduleInput,
  type ScaffoldSkillInput,
} from './scaffolding-api.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { TemplateRegistry } from '../template-engine/template-registry.ts';
import type { ScheduleEngine } from '../scheduler/schedule-engine.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';

const log = createLogger('scaffold-and-activate');

/**
 * One end-to-end path per artifact kind: validate (scaffoldingApi's create*
 * methods zod-parse their input) -> write file(s) -> reload the registry
 * that caches those files in memory -> git-commit -> {path, live: true}.
 *
 * This is what makes "Raven, learn to do X" in chat produce a LIVE artifact
 * instead of one that's inert until the next restart (the "five painted
 * doors" finding from the Phase 0-3 assessment). Both the MCP creation
 * tools (mcp-server/tools/scaffold.ts) and the REST /api/scaffold/* routes
 * call this same function — there is exactly one write+activate path per
 * kind, not two.
 */
export type ScaffoldSpec =
  | { kind: 'project'; input: ScaffoldProjectInput }
  | { kind: 'agent'; input: ScaffoldAgentInput }
  | { kind: 'template'; input: ScaffoldTemplateInput }
  | { kind: 'schedule'; input: ScaffoldScheduleInput }
  | { kind: 'skill'; input: ScaffoldSkillInput };

export interface ScaffoldActivateResult {
  /** Absolute filesystem path of the primary file written. */
  path: string;
  live: true;
}

export interface ReloadRegistriesResult {
  project: boolean;
  template: boolean;
  library: boolean;
  schedule: boolean;
}

export interface ScaffoldAndActivateDeps {
  scaffoldingApi: ScaffoldingApi;
  projectRegistry: ProjectRegistry;
  templateRegistry: TemplateRegistry;
  scheduleEngine: ScheduleEngine;
  capabilityLibrary: CapabilityLibrary;
  projectsDir: string;
  libraryDir: string;
}

export type ScaffoldAndActivateFn = (spec: ScaffoldSpec) => Promise<ScaffoldActivateResult>;

async function commit(path: string, message: string): Promise<ScaffoldActivateResult> {
  await gitAutoCommit([path], message).catch((err: unknown) => {
    log.warn(`gitAutoCommit failed (non-blocking): ${String(err)}`);
  });
  return { path, live: true };
}

/** Re-sync the cron engine against the global project's schedule set —
 * mirrors exactly what raven.ts passes at boot (createScheduleEngine's
 * `schedules` dep), so a scaffolded global schedule fires without a
 * restart. Project-scoped schedules are written to disk and picked up by
 * projectRegistry, but only global schedules are ever cron-scheduled (see
 * raven.ts) — a pre-existing constraint, unchanged here. */
function resyncScheduleEngine(deps: ScaffoldAndActivateDeps): void {
  deps.scheduleEngine.reload(deps.projectRegistry.getGlobal().schedules);
}

async function activateProject(
  input: ScaffoldProjectInput,
  deps: ScaffoldAndActivateDeps,
): Promise<ScaffoldActivateResult> {
  const relPath = await deps.scaffoldingApi.createProject(input);
  await deps.projectRegistry.load(deps.projectsDir);
  const filePath = join(resolveProjectDir(deps.projectsDir, relPath), 'context.md');
  return commit(filePath, `feat(project): scaffold "${relPath}"`);
}

async function activateAgent(
  input: ScaffoldAgentInput,
  deps: ScaffoldAndActivateDeps,
): Promise<ScaffoldActivateResult> {
  const name = await deps.scaffoldingApi.createAgent(input);
  await deps.projectRegistry.load(deps.projectsDir);
  const filePath = join(
    resolveProjectDir(deps.projectsDir, input.projectPath),
    'agents',
    `${name}.yaml`,
  );
  return commit(filePath, `feat(agent): scaffold "${name}"`);
}

async function activateTemplate(
  input: ScaffoldTemplateInput,
  deps: ScaffoldAndActivateDeps,
): Promise<ScaffoldActivateResult> {
  const name = await deps.scaffoldingApi.createTemplate(input);
  await deps.templateRegistry.load(deps.projectsDir);
  const filePath = join(
    resolveProjectDir(deps.projectsDir, input.projectPath),
    'templates',
    `${name}.yaml`,
  );
  return commit(filePath, `feat(template): scaffold "${name}"`);
}

async function activateSchedule(
  input: ScaffoldScheduleInput,
  deps: ScaffoldAndActivateDeps,
): Promise<ScaffoldActivateResult> {
  const name = await deps.scaffoldingApi.createSchedule(input);
  await deps.projectRegistry.load(deps.projectsDir);
  resyncScheduleEngine(deps);
  const filePath = join(
    resolveProjectDir(deps.projectsDir, input.projectPath),
    'schedules',
    `${name}.yaml`,
  );
  return commit(filePath, `feat(schedule): scaffold "${name}"`);
}

async function activateSkill(
  input: ScaffoldSkillInput,
  deps: ScaffoldAndActivateDeps,
): Promise<ScaffoldActivateResult> {
  const name = await deps.scaffoldingApi.createSkill(input);
  await deps.capabilityLibrary.load(deps.libraryDir);
  const filePath = join(deps.libraryDir, 'skills', input.domain, name);
  return commit(filePath, `feat(skill): scaffold "${input.domain}/${name}"`);
}

export function createScaffoldAndActivate(deps: ScaffoldAndActivateDeps): ScaffoldAndActivateFn {
  return async function scaffoldAndActivate(spec: ScaffoldSpec): Promise<ScaffoldActivateResult> {
    switch (spec.kind) {
      case 'project':
        return activateProject(spec.input, deps);
      case 'agent':
        return activateAgent(spec.input, deps);
      case 'template':
        return activateTemplate(spec.input, deps);
      case 'schedule':
        return activateSchedule(spec.input, deps);
      case 'skill':
        return activateSkill(spec.input, deps);
      default: {
        const unreachable: never = spec;
        throw new Error(`Unknown scaffold kind: ${JSON.stringify(unreachable)}`);
      }
    }
  };
}

/** Manual escape hatch: reload every registry from disk without writing
 * anything new. Each registry's own load()/reload() is independently
 * idempotent (safe to call even if nothing changed), so failures are
 * isolated per registry rather than aborting the whole reload. */
export function createReloadRegistries(
  deps: ScaffoldAndActivateDeps,
): () => Promise<ReloadRegistriesResult> {
  return async function reloadRegistries(): Promise<ReloadRegistriesResult> {
    const result: ReloadRegistriesResult = {
      project: false,
      template: false,
      library: false,
      schedule: false,
    };

    try {
      await deps.projectRegistry.load(deps.projectsDir);
      result.project = true;
    } catch (err) {
      log.warn(`Project registry reload failed: ${String(err)}`);
    }

    try {
      await deps.templateRegistry.load(deps.projectsDir);
      result.template = true;
    } catch (err) {
      log.warn(`Template registry reload failed: ${String(err)}`);
    }

    try {
      await deps.capabilityLibrary.load(deps.libraryDir);
      result.library = true;
    } catch (err) {
      log.warn(`Capability library reload failed: ${String(err)}`);
    }

    try {
      resyncScheduleEngine(deps);
      result.schedule = true;
    } catch (err) {
      log.warn(`Schedule engine resync failed: ${String(err)}`);
    }

    log.info(`Registries reloaded: ${JSON.stringify(result)}`);
    return result;
  };
}
