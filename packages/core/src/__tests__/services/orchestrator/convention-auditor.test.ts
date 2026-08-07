import type * as RavenShared from '@raven/shared';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof RavenShared>('@raven/shared');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

// ---------- convention-auditor: agent checks ----------

describe('convention-auditor: agent checks', () => {
  let tmpDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-agent-audit-'));
    configDir = join(tmpDir, 'config');
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should report no violations for valid agents.json', async () => {
    writeFileSync(
      join(configDir, 'agents.json'),
      JSON.stringify([
        { id: 'a1', name: 'my-agent', description: 'Test agent', suite_ids: [], is_default: true },
      ]),
    );

    const { auditConventions } =
      await import('../../../services/orchestrator/convention-auditor.ts');
    const report = await auditConventions(configDir);

    const agentViolations = report.violations.filter((v) => v.resourceType === 'agent');
    expect(agentViolations).toEqual([]);
  });

  it('should detect non-kebab-case agent name', async () => {
    writeFileSync(
      join(configDir, 'agents.json'),
      JSON.stringify([{ id: 'a1', name: 'BadName', description: 'Test', is_default: true }]),
    );

    const { auditConventions } =
      await import('../../../services/orchestrator/convention-auditor.ts');
    const report = await auditConventions(configDir);

    const naming = report.violations.find(
      (v) => v.rule === 'kebab-case-name' && v.resourceType === 'agent',
    );
    expect(naming).toBeDefined();
  });

  it('should detect missing default agent', async () => {
    writeFileSync(
      join(configDir, 'agents.json'),
      JSON.stringify([
        { id: 'a1', name: 'agent-one', description: 'Test', is_default: false },
        { id: 'a2', name: 'agent-two', description: 'Test', is_default: false },
      ]),
    );

    const { auditConventions } =
      await import('../../../services/orchestrator/convention-auditor.ts');
    const report = await auditConventions(configDir);

    const noDefault = report.violations.find((v) => v.rule === 'has-default-agent');
    expect(noDefault).toBeDefined();
    expect(noDefault!.severity).toBe('error');
  });
});

// ---------- convention-auditor: schedule checks ----------

describe('convention-auditor: schedule checks', () => {
  let tmpDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-sched-audit-'));
    configDir = join(tmpDir, 'config');
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should report no violations for valid schedules.json', async () => {
    writeFileSync(
      join(configDir, 'schedules.json'),
      JSON.stringify([
        {
          id: 's1',
          name: 'Morning Digest',
          cron: '0 8 * * *',
          taskType: 'morning-digest',
          skillName: 'digest',
          enabled: true,
        },
      ]),
    );

    const { auditConventions } =
      await import('../../../services/orchestrator/convention-auditor.ts');
    const report = await auditConventions(configDir);

    const schedViolations = report.violations.filter((v) => v.resourceType === 'schedule');
    expect(schedViolations).toEqual([]);
  });

  it('should detect duplicate IDs and missing fields', async () => {
    writeFileSync(
      join(configDir, 'schedules.json'),
      JSON.stringify([
        {
          id: 'dup',
          name: 'First',
          cron: '0 8 * * *',
          taskType: 'test',
          skillName: 'test',
          enabled: true,
        },
        { id: 'dup', name: 'Second', cron: 'bad', taskType: '', enabled: true },
      ]),
    );

    const { auditConventions } =
      await import('../../../services/orchestrator/convention-auditor.ts');
    const report = await auditConventions(configDir);

    const schedViolations = report.violations.filter((v) => v.resourceType === 'schedule');
    const rules = schedViolations.map((v) => v.rule);
    expect(rules).toContain('unique-id');
    expect(rules).toContain('valid-cron');
  });
});

// ---------- maintenance integration ----------

describe('convention-auditor: maintenance integration', () => {
  it('should include convention section in maintenance agent prompt', async () => {
    const { buildMaintenancePrompt } =
      await import('../../../services/orchestrator/maintenance-agent.ts');

    const prompt = buildMaintenancePrompt({
      logAnalysis: { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 },
      dependencyReport: { outdated: [], vulnerabilities: [], checkedAt: new Date().toISOString() },
      resourceReport: {
        dbSizeMB: 1,
        logSizeMB: 0.5,
        sessionSizeMB: 0.1,
        concerns: [],
        healthStatus: null,
        checkedAt: new Date().toISOString(),
      },
      conventionAuditReport: {
        violations: [
          {
            resourceType: 'agent',
            resourceName: 'test-agent',
            rule: 'has-description',
            severity: 'warning',
            message: 'Agent missing description',
            fix: 'Add a description explaining what this agent does',
          },
        ],
        compliantCount: 2,
        totalChecked: 3,
        checkedAt: new Date().toISOString(),
      },
      runDate: new Date().toISOString(),
    });

    expect(prompt).toContain('Convention Compliance');
    expect(prompt).toContain('test-agent');
    expect(prompt).toContain('has-description');
    expect(prompt).toContain('Agent missing description');
  });

  it('should show "All resources are compliant" when no violations', async () => {
    const { buildMaintenancePrompt } =
      await import('../../../services/orchestrator/maintenance-agent.ts');

    const prompt = buildMaintenancePrompt({
      logAnalysis: { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 },
      dependencyReport: { outdated: [], vulnerabilities: [], checkedAt: new Date().toISOString() },
      resourceReport: {
        dbSizeMB: 1,
        logSizeMB: 0.5,
        sessionSizeMB: 0.1,
        concerns: [],
        healthStatus: null,
        checkedAt: new Date().toISOString(),
      },
      conventionAuditReport: {
        violations: [],
        compliantCount: 5,
        totalChecked: 5,
        checkedAt: new Date().toISOString(),
      },
      runDate: new Date().toISOString(),
    });

    expect(prompt).toContain('All resources are compliant with conventions');
  });
});
