import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createLogger, PipelineConfigSchema } from '@raven/shared';
import type { ScheduleRecord } from '@raven/shared';

const log = createLogger('convention-auditor');

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface ConventionViolation {
  resourceType: 'suite' | 'pipeline' | 'agent' | 'schedule';
  resourceName: string;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}

export interface ConventionAuditReport {
  violations: ConventionViolation[];
  compliantCount: number;
  totalChecked: number;
  checkedAt: string;
}

/**
 * Scans all resources against convention rules and returns a structured report.
 */
export async function auditConventions(
  suitesDir: string,
  configDir: string,
): Promise<ConventionAuditReport> {
  const violations: ConventionViolation[] = [];
  let totalChecked = 0;

  // Audit suites
  const suiteViolations = auditSuites(suitesDir);
  violations.push(...suiteViolations.violations);
  totalChecked += suiteViolations.checked;

  // Audit pipelines
  const pipelineViolations = auditPipelines(configDir);
  violations.push(...pipelineViolations.violations);
  totalChecked += pipelineViolations.checked;

  // Audit agents
  const agentViolations = auditAgents(configDir);
  violations.push(...agentViolations.violations);
  totalChecked += agentViolations.checked;

  // Audit schedules
  const scheduleViolations = auditSchedules(configDir);
  violations.push(...scheduleViolations.violations);
  totalChecked += scheduleViolations.checked;

  const compliantCount = totalChecked - new Set(violations.map((v) => `${v.resourceType}:${v.resourceName}`)).size;

  log.info(`Convention audit complete: ${String(violations.length)} violations found across ${String(totalChecked)} resources`);

  return {
    violations,
    compliantCount,
    totalChecked,
    checkedAt: new Date().toISOString(),
  };
}

interface AuditResult {
  violations: ConventionViolation[];
  checked: number;
}

function auditSuites(suitesDir: string): AuditResult {
  const violations: ConventionViolation[] = [];
  let checked = 0;

  if (!existsSync(suitesDir)) return { violations, checked };

  const entries = readdirSync(suitesDir, { withFileTypes: true });
  const suiteDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  for (const dir of suiteDirs) {
    checked++;
    const suiteName = dir.name;
    const suitePath = join(suitesDir, suiteName);

    // Check kebab-case naming (allow _ prefix for _orchestrator)
    if (!suiteName.startsWith('_') && !KEBAB_CASE_RE.test(suiteName)) {
      violations.push({
        resourceType: 'suite',
        resourceName: suiteName,
        rule: 'kebab-case-name',
        severity: 'error',
        message: `Suite directory "${suiteName}" is not kebab-case`,
        fix: `Rename directory to kebab-case format`,
      });
    }

    // Check required files
    if (!existsSync(join(suitePath, 'suite.ts'))) {
      violations.push({
        resourceType: 'suite',
        resourceName: suiteName,
        rule: 'has-suite-ts',
        severity: 'error',
        message: `Missing suite.ts with defineSuite()`,
        fix: `Create suite.ts with defineSuite({ name: "${suiteName}", ... })`,
      });
    } else {
      // Check that suite.ts uses defineSuite()
      const content = readFileSync(join(suitePath, 'suite.ts'), 'utf-8');
      if (!content.includes('defineSuite')) {
        violations.push({
          resourceType: 'suite',
          resourceName: suiteName,
          rule: 'uses-define-suite',
          severity: 'error',
          message: `suite.ts does not use defineSuite()`,
          fix: `Export default using defineSuite({ ... })`,
        });
      }
    }

    if (!existsSync(join(suitePath, 'mcp.json'))) {
      violations.push({
        resourceType: 'suite',
        resourceName: suiteName,
        rule: 'has-mcp-json',
        severity: 'warning',
        message: `Missing mcp.json (even empty suites should have { "mcpServers": {} })`,
        fix: `Create mcp.json with { "mcpServers": {} }`,
      });
    }

    if (!existsSync(join(suitePath, 'actions.json'))) {
      violations.push({
        resourceType: 'suite',
        resourceName: suiteName,
        rule: 'has-actions-json',
        severity: 'warning',
        message: `Missing actions.json`,
        fix: `Create actions.json with action declarations`,
      });
    }

    if (!existsSync(join(suitePath, 'agents'))) {
      violations.push({
        resourceType: 'suite',
        resourceName: suiteName,
        rule: 'has-agents-dir',
        severity: 'warning',
        message: `Missing agents/ directory`,
        fix: `Create agents/ directory for agent definitions`,
      });
    }

    if (!existsSync(join(suitePath, 'UPDATE.md'))) {
      violations.push({
        resourceType: 'suite',
        resourceName: suiteName,
        rule: 'has-update-md',
        severity: 'warning',
        message: `Missing UPDATE.md for dependency monitoring`,
        fix: `Create UPDATE.md with dependency monitoring instructions`,
      });
    }
  }

  return { violations, checked };
}

function auditPipelines(configDir: string): AuditResult {
  const violations: ConventionViolation[] = [];
  let checked = 0;

  const pipelinesDir = join(configDir, 'pipelines');
  if (!existsSync(pipelinesDir)) return { violations, checked };

  const files = readdirSync(pipelinesDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  for (const file of files) {
    checked++;
    const pipelineName = basename(file, file.endsWith('.yaml') ? '.yaml' : '.yml');
    const filePath = join(pipelinesDir, file);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(content) as Record<string, unknown>;

      // Validate against Zod schema
      const result = PipelineConfigSchema.safeParse(parsed);
      if (!result.success) {
        violations.push({
          resourceType: 'pipeline',
          resourceName: pipelineName,
          rule: 'valid-schema',
          severity: 'error',
          message: `Schema validation failed: ${result.error.issues[0]?.message ?? 'unknown'}`,
          fix: `Fix pipeline YAML to match the expected schema`,
        });
      }

      // Check for trigger
      if (!parsed.trigger) {
        violations.push({
          resourceType: 'pipeline',
          resourceName: pipelineName,
          rule: 'has-trigger',
          severity: 'error',
          message: `Pipeline has no trigger defined`,
          fix: `Add a trigger: { type: cron|event|manual, ... }`,
        });
      }

      // Check version field
      if (parsed.version === undefined) {
        violations.push({
          resourceType: 'pipeline',
          resourceName: pipelineName,
          rule: 'has-version',
          severity: 'warning',
          message: `Pipeline missing version field`,
          fix: `Add version: 1 to the pipeline`,
        });
      }

      // Check enabled field
      if (parsed.enabled === undefined) {
        violations.push({
          resourceType: 'pipeline',
          resourceName: pipelineName,
          rule: 'has-enabled',
          severity: 'warning',
          message: `Pipeline missing enabled field`,
          fix: `Add enabled: true or enabled: false`,
        });
      }
    } catch (err) {
      violations.push({
        resourceType: 'pipeline',
        resourceName: pipelineName,
        rule: 'valid-yaml',
        severity: 'error',
        message: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
        fix: `Fix YAML syntax errors in ${file}`,
      });
    }
  }

  return { violations, checked };
}

function auditAgents(configDir: string): AuditResult {
  const violations: ConventionViolation[] = [];
  let checked = 0;

  const agentsPath = join(configDir, 'agents.json');
  if (!existsSync(agentsPath)) return { violations, checked };

  try {
    const content = readFileSync(agentsPath, 'utf-8');
    const agents = JSON.parse(content) as Array<{
      id: string;
      name: string;
      description?: string;
      suite_ids?: string[];
      is_default?: boolean;
    }>;

    let defaultCount = 0;

    for (const agent of agents) {
      checked++;

      // Check kebab-case naming
      if (!KEBAB_CASE_RE.test(agent.name)) {
        violations.push({
          resourceType: 'agent',
          resourceName: agent.name,
          rule: 'kebab-case-name',
          severity: 'error',
          message: `Agent name "${agent.name}" is not kebab-case`,
          fix: `Rename to kebab-case format`,
        });
      }

      // Check description
      if (!agent.description) {
        violations.push({
          resourceType: 'agent',
          resourceName: agent.name,
          rule: 'has-description',
          severity: 'warning',
          message: `Agent missing description`,
          fix: `Add a description explaining what this agent does`,
        });
      }

      if (agent.is_default) {
        defaultCount++;
      }
    }

    // Exactly one default agent
    if (defaultCount === 0) {
      violations.push({
        resourceType: 'agent',
        resourceName: 'agents.json',
        rule: 'has-default-agent',
        severity: 'error',
        message: `No default agent configured (need exactly one with is_default: true)`,
        fix: `Set is_default: true on one agent`,
      });
    } else if (defaultCount > 1) {
      violations.push({
        resourceType: 'agent',
        resourceName: 'agents.json',
        rule: 'single-default-agent',
        severity: 'error',
        message: `Multiple default agents configured (${String(defaultCount)} found, need exactly 1)`,
        fix: `Set is_default: true on only one agent`,
      });
    }
  } catch (err) {
    violations.push({
      resourceType: 'agent',
      resourceName: 'agents.json',
      rule: 'valid-json',
      severity: 'error',
      message: `Failed to parse agents.json: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Fix JSON syntax in agents.json`,
    });
  }

  return { violations, checked };
}

function auditSchedules(configDir: string): AuditResult {
  const violations: ConventionViolation[] = [];
  let checked = 0;

  // Schedules are in the DB, but we can also check schedules.json if it exists
  const schedulesPath = join(configDir, 'schedules.json');
  if (!existsSync(schedulesPath)) return { violations, checked };

  try {
    const content = readFileSync(schedulesPath, 'utf-8');
    const schedules = JSON.parse(content) as Array<{
      id: string;
      name: string;
      cron: string;
      taskType?: string;
      skillName?: string;
      enabled?: boolean;
    }>;

    const ids = new Set<string>();

    for (const schedule of schedules) {
      checked++;

      // Check unique ID
      if (ids.has(schedule.id)) {
        violations.push({
          resourceType: 'schedule',
          resourceName: schedule.name || schedule.id,
          rule: 'unique-id',
          severity: 'error',
          message: `Duplicate schedule ID: ${schedule.id}`,
          fix: `Use a unique ID for each schedule`,
        });
      }
      ids.add(schedule.id);

      // Check cron expression (basic: 5 fields separated by spaces)
      if (!schedule.cron || schedule.cron.split(' ').length < 5) {
        violations.push({
          resourceType: 'schedule',
          resourceName: schedule.name || schedule.id,
          rule: 'valid-cron',
          severity: 'error',
          message: `Invalid cron expression: "${schedule.cron}"`,
          fix: `Use a standard 5-field cron expression (e.g. "0 8 * * *")`,
        });
      }

      // Check taskType
      if (!schedule.taskType) {
        violations.push({
          resourceType: 'schedule',
          resourceName: schedule.name || schedule.id,
          rule: 'has-task-type',
          severity: 'error',
          message: `Schedule missing taskType`,
          fix: `Add taskType field`,
        });
      }

      // Check skillName
      if (!schedule.skillName) {
        violations.push({
          resourceType: 'schedule',
          resourceName: schedule.name || schedule.id,
          rule: 'has-skill-name',
          severity: 'warning',
          message: `Schedule missing skillName`,
          fix: `Add skillName referencing a registered suite`,
        });
      }
    }
  } catch (err) {
    violations.push({
      resourceType: 'schedule',
      resourceName: 'schedules.json',
      rule: 'valid-json',
      severity: 'error',
      message: `Failed to parse schedules.json: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Fix JSON syntax in schedules.json`,
    });
  }

  return { violations, checked };
}
