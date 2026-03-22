import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof import('@raven/shared')>('@raven/shared');
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

// ---------- convention-auditor: suite checks ----------

describe('convention-auditor: suite checks', () => {
  let suitesDir: string;
  let configDir: string;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'raven-audit-'));
    suitesDir = join(tmpDir, 'suites');
    configDir = join(tmpDir, 'config');
    mkdirSync(suitesDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up both dirs (parent of suitesDir)
    rmSync(join(suitesDir, '..'), { recursive: true, force: true });
  });

  it('should report no violations for a fully compliant suite', async () => {
    const suitePath = join(suitesDir, 'my-suite');
    mkdirSync(suitePath, { recursive: true });
    mkdirSync(join(suitePath, 'agents'), { recursive: true });
    writeFileSync(
      join(suitePath, 'suite.ts'),
      'import { defineSuite } from "@raven/shared"; export default defineSuite({ name: "my-suite" });',
    );
    writeFileSync(join(suitePath, 'mcp.json'), '{ "mcpServers": {} }');
    writeFileSync(join(suitePath, 'actions.json'), '[]');
    writeFileSync(join(suitePath, 'UPDATE.md'), '# My Suite Update Guide');

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const suiteViolations = report.violations.filter((v) => v.resourceName === 'my-suite');
    expect(suiteViolations).toEqual([]);
    expect(report.totalChecked).toBeGreaterThanOrEqual(1);
  });

  it('should detect missing suite.ts', async () => {
    const suitePath = join(suitesDir, 'bad-suite');
    mkdirSync(suitePath, { recursive: true });

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const missingFile = report.violations.find(
      (v) => v.resourceName === 'bad-suite' && v.rule === 'has-suite-ts',
    );
    expect(missingFile).toBeDefined();
    expect(missingFile!.severity).toBe('error');
  });

  it('should detect suite.ts without defineSuite()', async () => {
    const suitePath = join(suitesDir, 'no-define');
    mkdirSync(suitePath, { recursive: true });
    writeFileSync(join(suitePath, 'suite.ts'), 'export default { name: "no-define" };');

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const noDefine = report.violations.find(
      (v) => v.resourceName === 'no-define' && v.rule === 'uses-define-suite',
    );
    expect(noDefine).toBeDefined();
  });

  it('should detect missing mcp.json, actions.json, agents/, UPDATE.md', async () => {
    const suitePath = join(suitesDir, 'minimal');
    mkdirSync(suitePath, { recursive: true });
    writeFileSync(
      join(suitePath, 'suite.ts'),
      'import { defineSuite } from "@raven/shared"; export default defineSuite({ name: "minimal" });',
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const minimalViolations = report.violations.filter((v) => v.resourceName === 'minimal');
    const rules = minimalViolations.map((v) => v.rule);
    expect(rules).toContain('has-mcp-json');
    expect(rules).toContain('has-actions-json');
    expect(rules).toContain('has-agents-dir');
    expect(rules).toContain('has-update-md');
  });

  it('should detect non-kebab-case suite directory name', async () => {
    const suitePath = join(suitesDir, 'MyBadName');
    mkdirSync(suitePath, { recursive: true });
    writeFileSync(
      join(suitePath, 'suite.ts'),
      'import { defineSuite } from "@raven/shared"; export default defineSuite({ name: "MyBadName" });',
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const naming = report.violations.find(
      (v) => v.resourceName === 'MyBadName' && v.rule === 'kebab-case-name',
    );
    expect(naming).toBeDefined();
    expect(naming!.severity).toBe('error');
  });
});

// ---------- convention-auditor: pipeline checks ----------

describe('convention-auditor: pipeline checks', () => {
  let suitesDir: string;
  let configDir: string;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'raven-pipe-audit-'));
    suitesDir = join(tmpDir, 'suites');
    configDir = join(tmpDir, 'config');
    mkdirSync(suitesDir, { recursive: true });
    mkdirSync(join(configDir, 'pipelines'), { recursive: true });
  });

  afterEach(() => {
    rmSync(join(suitesDir, '..'), { recursive: true, force: true });
  });

  it('should report no violations for valid pipeline YAML', async () => {
    writeFileSync(
      join(configDir, 'pipelines', 'good-pipeline.yaml'),
      `name: good-pipeline
version: 1
trigger:
  type: cron
  schedule: "0 8 * * *"
nodes:
  fetch-data:
    skill: email
    action: fetch
connections: []
enabled: true
`,
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const pipeViolations = report.violations.filter((v) => v.resourceName === 'good-pipeline');
    expect(pipeViolations).toEqual([]);
  });

  it('should detect missing version and enabled fields', async () => {
    writeFileSync(
      join(configDir, 'pipelines', 'no-version.yaml'),
      `name: no-version
trigger:
  type: manual
nodes:
  do-thing:
    skill: test
    action: run
connections: []
`,
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const violations = report.violations.filter((v) => v.resourceName === 'no-version');
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain('has-version');
    expect(rules).toContain('has-enabled');
  });

  it('should detect invalid YAML', async () => {
    writeFileSync(join(configDir, 'pipelines', 'bad-yaml.yaml'), 'this is: [not valid yaml: {{');

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const badYaml = report.violations.find((v) => v.resourceName === 'bad-yaml' && v.rule === 'valid-yaml');
    expect(badYaml).toBeDefined();
    expect(badYaml!.severity).toBe('error');
  });
});

// ---------- convention-auditor: agent checks ----------

describe('convention-auditor: agent checks', () => {
  let suitesDir: string;
  let configDir: string;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'raven-agent-audit-'));
    suitesDir = join(tmpDir, 'suites');
    configDir = join(tmpDir, 'config');
    mkdirSync(suitesDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(join(suitesDir, '..'), { recursive: true, force: true });
  });

  it('should report no violations for valid agents.json', async () => {
    writeFileSync(
      join(configDir, 'agents.json'),
      JSON.stringify([
        { id: 'a1', name: 'my-agent', description: 'Test agent', suite_ids: [], is_default: true },
      ]),
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const agentViolations = report.violations.filter((v) => v.resourceType === 'agent');
    expect(agentViolations).toEqual([]);
  });

  it('should detect non-kebab-case agent name', async () => {
    writeFileSync(
      join(configDir, 'agents.json'),
      JSON.stringify([
        { id: 'a1', name: 'BadName', description: 'Test', is_default: true },
      ]),
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const naming = report.violations.find((v) => v.rule === 'kebab-case-name' && v.resourceType === 'agent');
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

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const noDefault = report.violations.find((v) => v.rule === 'has-default-agent');
    expect(noDefault).toBeDefined();
    expect(noDefault!.severity).toBe('error');
  });
});

// ---------- convention-auditor: schedule checks ----------

describe('convention-auditor: schedule checks', () => {
  let suitesDir: string;
  let configDir: string;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'raven-sched-audit-'));
    suitesDir = join(tmpDir, 'suites');
    configDir = join(tmpDir, 'config');
    mkdirSync(suitesDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(join(suitesDir, '..'), { recursive: true, force: true });
  });

  it('should report no violations for valid schedules.json', async () => {
    writeFileSync(
      join(configDir, 'schedules.json'),
      JSON.stringify([
        { id: 's1', name: 'Morning Digest', cron: '0 8 * * *', taskType: 'morning-digest', skillName: 'digest', enabled: true },
      ]),
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const schedViolations = report.violations.filter((v) => v.resourceType === 'schedule');
    expect(schedViolations).toEqual([]);
  });

  it('should detect duplicate IDs and missing fields', async () => {
    writeFileSync(
      join(configDir, 'schedules.json'),
      JSON.stringify([
        { id: 'dup', name: 'First', cron: '0 8 * * *', taskType: 'test', skillName: 'test', enabled: true },
        { id: 'dup', name: 'Second', cron: 'bad', taskType: '', enabled: true },
      ]),
    );

    const { auditConventions } = await import('../services/convention-auditor.ts');
    const report = await auditConventions(suitesDir, configDir);

    const schedViolations = report.violations.filter((v) => v.resourceType === 'schedule');
    const rules = schedViolations.map((v) => v.rule);
    expect(rules).toContain('unique-id');
    expect(rules).toContain('valid-cron');
  });
});

// ---------- maintenance integration ----------

describe('convention-auditor: maintenance integration', () => {
  it('should include convention section in maintenance agent prompt', async () => {
    const { buildMaintenancePrompt } = await import('../services/maintenance-agent.ts');

    const prompt = buildMaintenancePrompt({
      logAnalysis: { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 },
      dependencyReport: { outdated: [], vulnerabilities: [] },
      resourceReport: { dbSizeMB: 1, logSizeMB: 0.5, sessionSizeMB: 0.1, concerns: [], healthStatus: null },
      suiteUpdateReport: { installedSuites: [], suitesWithUpdates: [], suitesWithoutUpdates: [] },
      conventionAuditReport: {
        violations: [
          {
            resourceType: 'suite',
            resourceName: 'test-suite',
            rule: 'has-update-md',
            severity: 'warning',
            message: 'Missing UPDATE.md',
            fix: 'Create UPDATE.md',
          },
        ],
        compliantCount: 2,
        totalChecked: 3,
        checkedAt: new Date().toISOString(),
      },
      runDate: new Date().toISOString(),
    });

    expect(prompt).toContain('Convention Compliance');
    expect(prompt).toContain('test-suite');
    expect(prompt).toContain('has-update-md');
    expect(prompt).toContain('Missing UPDATE.md');
  });

  it('should show "All resources are compliant" when no violations', async () => {
    const { buildMaintenancePrompt } = await import('../services/maintenance-agent.ts');

    const prompt = buildMaintenancePrompt({
      logAnalysis: { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 },
      dependencyReport: { outdated: [], vulnerabilities: [] },
      resourceReport: { dbSizeMB: 1, logSizeMB: 0.5, sessionSizeMB: 0.1, concerns: [], healthStatus: null },
      suiteUpdateReport: { installedSuites: [], suitesWithUpdates: [], suitesWithoutUpdates: [] },
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

// ---------- config-manager convention injection ----------

describe('config-manager: convention doc injection', () => {
  it('should include convention docs in prompt when provided', async () => {
    const { buildConfigManagerPrompt } = await import('../agents/config-manager.ts');

    const prompt = buildConfigManagerPrompt({
      pipelines: [],
      suites: [],
      agents: [],
      schedules: [],
      conventionDocs: {
        'Pipeline Conventions': '## Pipeline naming\nUse kebab-case verb-noun format.',
        'Suite Conventions': '## Required files\nsuite.ts, mcp.json, actions.json',
      },
    });

    expect(prompt).toContain('Convention Documents');
    expect(prompt).toContain('Pipeline Conventions');
    expect(prompt).toContain('kebab-case verb-noun');
    expect(prompt).toContain('Suite Conventions');
    expect(prompt).toContain('Required files');
  });

  it('should not include convention section when no docs provided', async () => {
    const { buildConfigManagerPrompt } = await import('../agents/config-manager.ts');

    const prompt = buildConfigManagerPrompt({
      pipelines: [],
      suites: [],
      agents: [],
      schedules: [],
    });

    expect(prompt).not.toContain('Convention Documents');
    expect(prompt).toContain('Output Format');
  });
});
