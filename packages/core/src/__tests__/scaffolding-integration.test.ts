import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { load as yamlLoad } from 'js-yaml';

import { createScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import type { ScaffoldingApi, ScaffoldPlan } from '../scaffolding/scaffolding-api.ts';
import type { AgentYaml, ScheduleYaml, TaskTemplate } from '@raven/shared';
import { ProjectRegistry } from '../project-registry/project-registry.ts';
import { validateProjects } from '../project-registry/project-validator.ts';
import { createAgentYamlStore } from '../project-registry/agent-yaml-store.ts';

// ── Test data: realistic university domain ──────────────────────────────

const coordinatorAgent: AgentYaml = {
  name: 'coordinator',
  displayName: 'University Coordinator',
  description: 'Coordinates academic tasks across subjects',
  skills: ['calendar', 'ticktick'],
  isDefault: true,
  model: 'sonnet',
  maxTurns: 20,
};

const calcHelperAgent: AgentYaml = {
  name: 'calc-helper',
  displayName: 'Calculus Helper',
  description: 'Assists with calculus problem-solving and note review',
  skills: ['note-taking'],
  isDefault: false,
  model: 'sonnet',
  maxTurns: 10,
};

function makeExamPrepTemplate(): TaskTemplate {
  return {
    name: 'exam-prep',
    displayName: 'Exam Preparation',
    description: 'Prepare study materials and review schedule for upcoming exam',
    params: {
      subject: { type: 'string', description: 'Subject name', required: true },
      examDate: { type: 'string', description: 'Exam date', required: true },
    },
    trigger: [{ type: 'manual' }],
    plan: { approval: 'manual', parallel: false },
    tasks: [
      {
        id: 'gather-notes',
        title: 'Gather and organize notes',
        type: 'agent',
        agent: 'calc-helper',
        prompt: 'Gather all notes for {{subject}} and create a summary document',
      },
      {
        id: 'create-schedule',
        title: 'Create study schedule',
        type: 'agent',
        agent: 'coordinator',
        prompt: 'Create a study schedule leading up to {{examDate}} for {{subject}}',
        blockedBy: ['gather-notes'],
      },
    ],
  } as unknown as TaskTemplate;
}

const dailyCheckSchedule: ScheduleYaml = {
  name: 'daily-check',
  cron: '0 8 * * 1-5',
  timezone: 'America/New_York',
  template: 'exam-prep',
  enabled: true,
};

function buildUniversityPlan(): ScaffoldPlan {
  return {
    projects: [
      { path: 'uni', displayName: 'University', description: 'All academic projects' },
      { path: 'uni/calculus', displayName: 'Calculus', description: 'Calculus coursework' },
      { path: 'uni/physics', displayName: 'Physics', description: 'Physics coursework' },
    ],
    agents: [
      { projectPath: 'uni', agent: coordinatorAgent },
      { projectPath: 'uni/calculus', agent: calcHelperAgent },
    ],
    templates: [{ projectPath: 'uni', template: makeExamPrepTemplate() }],
    schedules: [{ projectPath: 'uni', schedule: dailyCheckSchedule }],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('scaffolding integration', () => {
  let tmpDir: string;
  let api: ScaffoldingApi;
  let registry: ProjectRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffolding-int-'));
    registry = new ProjectRegistry();
    const agentStore = createAgentYamlStore();
    api = createScaffoldingApi({
      projectsDir: tmpDir,
      projectRegistry: registry,
      agentYamlStore: agentStore,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scaffolds a complete university domain', async () => {
    const plan = buildUniversityPlan();
    const result = await api.scaffoldDomain(plan);

    // No errors
    expect(result.errors).toEqual([]);

    // All items created
    expect(result.projectsCreated).toEqual(['uni', 'uni/calculus', 'uni/physics']);
    expect(result.agentsCreated).toEqual(['coordinator', 'calc-helper']);
    expect(result.templatesCreated).toEqual(['exam-prep']);
    expect(result.schedulesCreated).toEqual(['daily-check']);

    // Directories exist
    expect(existsSync(join(tmpDir, 'uni', 'context.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'uni/calculus', 'context.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'uni/physics', 'context.md'))).toBe(true);

    // Agent YAML files exist and are valid
    const coordYaml = await readFile(join(tmpDir, 'uni/agents/coordinator.yaml'), 'utf-8');
    const coordParsed = yamlLoad(coordYaml) as Record<string, unknown>;
    expect(coordParsed.name).toBe('coordinator');
    expect(coordParsed.skills).toEqual(['calendar', 'ticktick']);

    const calcYaml = await readFile(join(tmpDir, 'uni/calculus/agents/calc-helper.yaml'), 'utf-8');
    const calcParsed = yamlLoad(calcYaml) as Record<string, unknown>;
    expect(calcParsed.name).toBe('calc-helper');
    expect(calcParsed.skills).toEqual(['note-taking']);

    // Template YAML exists and is valid
    const templateYaml = await readFile(join(tmpDir, 'uni/templates/exam-prep.yaml'), 'utf-8');
    const templateParsed = yamlLoad(templateYaml) as Record<string, unknown>;
    expect(templateParsed.name).toBe('exam-prep');
    expect(templateParsed.tasks).toHaveLength(2);

    // Schedule YAML exists and is valid
    const scheduleYaml = await readFile(join(tmpDir, 'uni/schedules/daily-check.yaml'), 'utf-8');
    const scheduleParsed = yamlLoad(scheduleYaml) as Record<string, unknown>;
    expect(scheduleParsed.name).toBe('daily-check');
    expect(scheduleParsed.cron).toBe('0 8 * * 1-5');
  });

  it('created files pass project validation', async () => {
    const plan = buildUniversityPlan();
    await api.scaffoldDomain(plan);

    const errors = await validateProjects(tmpDir);
    expect(errors).toEqual([]);
  });

  it('project registry resolves inheritance after scaffolding', async () => {
    const plan = buildUniversityPlan();
    await api.scaffoldDomain(plan);

    // Registry was reloaded by scaffoldDomain — reload explicitly to verify from scratch
    await registry.load(tmpDir);

    // uni/calculus should exist
    const calcProject = registry.getProject('uni/calculus');
    expect(calcProject).toBeDefined();
    expect(calcProject!.name).toBe('calculus');

    // Resolve context for uni/calculus — should inherit agents from uni
    const resolved = registry.resolveProjectContext('uni/calculus');

    // Context chain should include global (root), uni, and uni/calculus
    expect(resolved.contextChain.length).toBeGreaterThanOrEqual(2);

    // Should have both the coordinator (from uni) and calc-helper (from uni/calculus)
    expect(resolved.agents.has('coordinator')).toBe(true);
    expect(resolved.agents.has('calc-helper')).toBe(true);

    // Schedule from uni should be inherited
    expect(resolved.schedules.some((s) => s.name === 'daily-check')).toBe(true);
  });
});
