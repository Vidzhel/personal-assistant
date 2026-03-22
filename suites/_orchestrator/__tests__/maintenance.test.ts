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
    getLogDir: () => null,
  };
});

// ---------- log-analyzer ----------

describe('log-analyzer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-log-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty results when no log files exist', async () => {
    const { analyzeLogs } = await import('../services/log-analyzer.ts');
    const result = await analyzeLogs(tmpDir);

    expect(result.recurringErrors).toEqual([]);
    expect(result.silentFailures).toEqual([]);
    expect(result.totalErrors).toBe(0);
    expect(result.totalWarnings).toBe(0);
  });

  it('should group recurring errors by component and pattern', async () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({
        level: 50,
        time: now - 1000,
        component: 'db',
        msg: 'Connection timeout after 5000ms',
      }),
      JSON.stringify({
        level: 50,
        time: now - 2000,
        component: 'db',
        msg: 'Connection timeout after 5000ms',
      }),
      JSON.stringify({
        level: 50,
        time: now - 3000,
        component: 'db',
        msg: 'Connection timeout after 5000ms',
      }),
      JSON.stringify({ level: 30, time: now, component: 'api', msg: 'Request handled' }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'raven.1.log'), lines);

    const { analyzeLogs } = await import('../services/log-analyzer.ts');
    const result = await analyzeLogs(tmpDir);

    expect(result.totalErrors).toBe(3);
    expect(result.recurringErrors.length).toBe(1);
    expect(result.recurringErrors[0].component).toBe('db');
    expect(result.recurringErrors[0].count).toBe(3);
    expect(result.recurringErrors[0].pattern).toContain('Connection timeout');
  });

  it('should normalize UUIDs and timestamps in error patterns', async () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({
        level: 50,
        time: now - 1000,
        component: 'agent',
        msg: 'Task a1b2c3d4-e5f6-7890-abcd-ef1234567890 failed',
      }),
      JSON.stringify({
        level: 50,
        time: now - 2000,
        component: 'agent',
        msg: 'Task 11111111-2222-3333-4444-555555555555 failed',
      }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'raven.1.log'), lines);

    const { analyzeLogs } = await import('../services/log-analyzer.ts');
    const result = await analyzeLogs(tmpDir);

    // Both errors should be grouped as the same pattern (UUIDs normalized)
    expect(result.recurringErrors.length).toBe(1);
    expect(result.recurringErrors[0].count).toBe(2);
    expect(result.recurringErrors[0].pattern).toContain('<UUID>');
  });

  it('should detect silent failures for components with old last entry', async () => {
    const twoDaysAgo = Date.now() - 2 * 86_400_000;
    const lines = [
      JSON.stringify({ level: 30, time: twoDaysAgo, component: 'stale-service', msg: 'Running' }),
      JSON.stringify({ level: 30, time: Date.now(), component: 'active-service', msg: 'Running' }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'raven.1.log'), lines);

    const { analyzeLogs } = await import('../services/log-analyzer.ts');
    const result = await analyzeLogs(tmpDir);

    expect(result.silentFailures.length).toBe(1);
    expect(result.silentFailures[0].component).toBe('stale-service');
  });

  it('should count warnings separately from errors', async () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({ level: 40, time: now, component: 'api', msg: 'Slow response' }),
      JSON.stringify({ level: 40, time: now, component: 'api', msg: 'Slow response' }),
      JSON.stringify({ level: 50, time: now, component: 'db', msg: 'Connection lost' }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'raven.1.log'), lines);

    const { analyzeLogs } = await import('../services/log-analyzer.ts');
    const result = await analyzeLogs(tmpDir);

    expect(result.totalWarnings).toBe(2);
    expect(result.totalErrors).toBe(1);
  });

  it('should skip entries older than 7 days', async () => {
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    const lines = [
      JSON.stringify({ level: 50, time: eightDaysAgo, component: 'old', msg: 'Old error' }),
      JSON.stringify({ level: 50, time: eightDaysAgo, component: 'old', msg: 'Old error' }),
    ].join('\n');

    writeFileSync(join(tmpDir, 'raven.1.log'), lines);

    const { analyzeLogs } = await import('../services/log-analyzer.ts');
    const result = await analyzeLogs(tmpDir);

    expect(result.recurringErrors).toEqual([]);
    expect(result.totalErrors).toBe(0);
  });
});

// ---------- dependency-checker ----------

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: () => mockExecFile,
  };
});

describe('dependency-checker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-dep-test-'));
    mockExecFile.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should parse npm outdated output and classify updates', async () => {
    mockExecFile.mockRejectedValue(
      Object.assign(new Error('exit 1'), {
        stdout: JSON.stringify({
          'some-package': { current: '1.0.0', wanted: '1.2.0', latest: '2.0.0' },
          'minor-pkg': { current: '3.1.0', wanted: '3.2.0', latest: '3.2.0' },
          'patch-pkg': { current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        }),
        stderr: '',
        code: 1,
      }),
    );

    const { checkDependencies } = await import('../services/dependency-checker.ts');
    const result = await checkDependencies(tmpDir);

    // Should be sorted: major first, then minor, then patch
    expect(result.outdated.length).toBe(3);
    expect(result.outdated[0].updateType).toBe('major');
    expect(result.outdated[0].name).toBe('some-package');
    expect(result.outdated[1].updateType).toBe('minor');
    expect(result.outdated[2].updateType).toBe('patch');
  });

  it('should parse npm audit vulnerabilities', async () => {
    const auditOutput = JSON.stringify({
      vulnerabilities: {
        'bad-pkg': {
          name: 'bad-pkg',
          severity: 'high',
          via: [
            { title: 'Prototype Pollution', url: 'https://example.com/advisory', severity: 'high' },
          ],
          range: '>=1.0.0 <1.5.0',
        },
      },
    });

    mockExecFile.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'outdated') return Promise.resolve({ stdout: '{}' });
      return Promise.reject(
        Object.assign(new Error('exit 1'), { stdout: auditOutput, stderr: '', code: 1 }),
      );
    });

    const { checkDependencies } = await import('../services/dependency-checker.ts');
    const result = await checkDependencies(tmpDir);

    expect(result.vulnerabilities.length).toBe(1);
    expect(result.vulnerabilities[0].name).toBe('bad-pkg');
    expect(result.vulnerabilities[0].severity).toBe('high');
    expect(result.vulnerabilities[0].title).toBe('Prototype Pollution');
  });
});

// ---------- resource-monitor ----------

describe('resource-monitor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-resource-test-'));
    // Create data structure
    mkdirSync(join(tmpDir, 'logs'), { recursive: true });
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should report file sizes and flag concerns for missing health endpoint', async () => {
    // Create a small DB file
    writeFileSync(join(tmpDir, 'raven.db'), 'x'.repeat(1024));
    // Create some log files
    writeFileSync(join(tmpDir, 'logs', 'raven.1.log'), 'y'.repeat(2048));

    // Mock fetch to simulate unreachable health endpoint
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const { checkResources } = await import('../services/resource-monitor.ts');
    const result = await checkResources(tmpDir, 'http://localhost:9999/api/health');

    expect(result.dbSizeMB).toBeGreaterThan(0);
    expect(result.logSizeMB).toBeGreaterThan(0);
    expect(result.healthStatus).toBeNull();
    expect(result.concerns).toContain('Health endpoint unreachable');
  });

  it('should parse health endpoint response and calculate failure rate', async () => {
    writeFileSync(join(tmpDir, 'raven.db'), 'x');

    const healthResponse = {
      status: 'ok',
      uptime: 3600,
      memory: { heapUsedMB: 100, heapTotalMB: 200 },
      taskStats: { total1h: 10, failed1h: 3 },
      subsystems: {},
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(healthResponse),
      }),
    );

    const { checkResources } = await import('../services/resource-monitor.ts');
    const result = await checkResources(tmpDir, 'http://localhost:4001/api/health');

    expect(result.healthStatus).not.toBeNull();
    expect(result.healthStatus!.status).toBe('ok');
    expect(result.healthStatus!.failureRate).toBeCloseTo(0.3);
    // 30% failure rate > 10% threshold
    expect(result.concerns.some((c) => c.includes('failure rate'))).toBe(true);
  });

  it('should flag high heap usage', async () => {
    writeFileSync(join(tmpDir, 'raven.db'), 'x');

    const healthResponse = {
      status: 'ok',
      uptime: 3600,
      memory: { heapUsedMB: 450, heapTotalMB: 512 },
      taskStats: { total1h: 0, failed1h: 0 },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(healthResponse),
      }),
    );

    const { checkResources } = await import('../services/resource-monitor.ts');
    const result = await checkResources(tmpDir, 'http://localhost:4001/api/health');

    expect(result.concerns.some((c) => c.includes('Heap usage'))).toBe(true);
  });
});

// ---------- suite-update-checker ----------

describe('suite-update-checker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-suite-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should detect suites with and without UPDATE.md', async () => {
    // Suite with UPDATE.md
    mkdirSync(join(tmpDir, 'notifications'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'notifications', 'UPDATE.md'),
      '# Notifications Update\nCheck grammy releases',
    );

    // Suite without UPDATE.md
    mkdirSync(join(tmpDir, 'email'), { recursive: true });

    const { checkSuiteUpdates } = await import('../services/suite-update-checker.ts');
    const result = await checkSuiteUpdates(tmpDir);

    expect(result.installedSuites).toContain('notifications');
    expect(result.installedSuites).toContain('email');
    expect(result.suitesWithUpdates.length).toBe(1);
    expect(result.suitesWithUpdates[0].name).toBe('notifications');
    expect(result.suitesWithUpdates[0].checkInstructions).toBe('Notifications Update');
    expect(result.suitesWithoutUpdates).toContain('email');
  });

  it('should return empty report for empty directory', async () => {
    const { checkSuiteUpdates } = await import('../services/suite-update-checker.ts');
    const result = await checkSuiteUpdates(tmpDir);

    expect(result.installedSuites).toEqual([]);
    expect(result.suitesWithUpdates).toEqual([]);
    expect(result.suitesWithoutUpdates).toEqual([]);
  });

  it('should skip non-directory entries', async () => {
    writeFileSync(join(tmpDir, 'vitest.config.ts'), 'export default {}');
    mkdirSync(join(tmpDir, 'real-suite'), { recursive: true });

    const { checkSuiteUpdates } = await import('../services/suite-update-checker.ts');
    const result = await checkSuiteUpdates(tmpDir);

    expect(result.installedSuites).toEqual(['real-suite']);
  });
});

// ---------- maintenance-report ----------

describe('maintenance-report', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-report-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should compile a report and write to disk', async () => {
    const { compileReport } = await import('../services/maintenance-report.ts');

    const result = await compileReport(
      {
        logAnalysis: { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 },
        dependencyReport: {
          outdated: [],
          vulnerabilities: [],
          checkedAt: new Date().toISOString(),
        },
        resourceReport: {
          dbSizeMB: 10,
          logSizeMB: 5,
          sessionSizeMB: 1,
          healthStatus: { status: 'ok', heapUsedMB: 100, heapTotalMB: 200 },
          concerns: [],
          checkedAt: new Date().toISOString(),
        },
        suiteUpdateReport: {
          suitesWithUpdates: [],
          suitesWithoutUpdates: [],
          installedSuites: ['notifications'],
          checkedAt: new Date().toISOString(),
        },
      },
      join(tmpDir, 'reports'),
    );

    expect(result.markdown).toContain('Maintenance Report');
    expect(result.filePath).toContain('.md');
    // Verify file was written
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toBe(result.markdown);
  });

  it('should use agent analysis when provided', async () => {
    const { compileReport } = await import('../services/maintenance-report.ts');

    const agentReport = '# Custom Agent Report\n\nDetailed analysis here.';
    const result = await compileReport(
      {
        logAnalysis: { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 },
        dependencyReport: {
          outdated: [],
          vulnerabilities: [],
          checkedAt: new Date().toISOString(),
        },
        resourceReport: {
          dbSizeMB: 0,
          logSizeMB: 0,
          sessionSizeMB: 0,
          healthStatus: null,
          concerns: [],
          checkedAt: new Date().toISOString(),
        },
        suiteUpdateReport: {
          suitesWithUpdates: [],
          suitesWithoutUpdates: [],
          installedSuites: [],
          checkedAt: new Date().toISOString(),
        },
        agentAnalysis: agentReport,
      },
      join(tmpDir, 'reports'),
    );

    expect(result.markdown).toBe(agentReport);
  });

  it('should emit report event with correct shape', async () => {
    const { emitReportEvent } = await import('../services/maintenance-report.ts');
    const emitted: any[] = [];
    const mockBus = {
      emit: vi.fn((e: any) => emitted.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    };

    emitReportEvent(mockBus as any, {
      markdown: '# Report',
      date: '2026-03-22',
      filePath: '/tmp/report.md',
    });

    expect(emitted.length).toBe(1);
    expect(emitted[0].type).toBe('maintenance:report:generated');
    expect(emitted[0].payload.date).toBe('2026-03-22');
    expect(emitted[0].payload.filePath).toBe('/tmp/report.md');
  });

  it('should send notification via event bus', async () => {
    const { sendReportNotification } = await import('../services/maintenance-report.ts');
    const emitted: any[] = [];
    const mockBus = {
      emit: vi.fn((e: any) => emitted.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    };

    sendReportNotification(mockBus as any, {
      markdown: '# Short Report',
      date: '2026-03-22',
      filePath: '/tmp/report.md',
    });

    expect(emitted.length).toBe(1);
    expect(emitted[0].type).toBe('notification');
    expect(emitted[0].payload.channel).toBe('telegram');
    expect(emitted[0].payload.topicName).toBe('Raven System');
  });

  it('should truncate long reports for Telegram notification', async () => {
    const { sendReportNotification } = await import('../services/maintenance-report.ts');
    const emitted: any[] = [];
    const mockBus = {
      emit: vi.fn((e: any) => emitted.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    };

    const longReport = 'x'.repeat(5000);
    sendReportNotification(mockBus as any, {
      markdown: longReport,
      date: '2026-03-22',
      filePath: '/tmp/report.md',
    });

    expect(emitted[0].payload.body.length).toBeLessThan(5000);
    expect(emitted[0].payload.body).toContain('truncated');
  });
});

// ---------- maintenance-agent (prompt builder) ----------

describe('maintenance-agent prompt builder', () => {
  it('should build a structured prompt with all sections', async () => {
    const { buildMaintenancePrompt } = await import('../services/maintenance-agent.ts');

    const prompt = buildMaintenancePrompt({
      logAnalysis: {
        recurringErrors: [
          {
            component: 'db',
            pattern: 'Connection timeout',
            count: 5,
            lastSeen: '2026-03-22T00:00:00Z',
          },
        ],
        silentFailures: [{ component: 'old-service', lastEntry: '2026-03-20T00:00:00Z' }],
        totalErrors: 5,
        totalWarnings: 2,
      },
      dependencyReport: {
        outdated: [
          {
            name: 'express',
            current: '4.18.0',
            wanted: '4.19.0',
            latest: '5.0.0',
            updateType: 'major',
          },
        ],
        vulnerabilities: [
          {
            name: 'bad-pkg',
            severity: 'high',
            title: 'XSS',
            url: 'https://example.com',
            range: '>=1.0.0',
          },
        ],
        checkedAt: '2026-03-22T00:00:00Z',
      },
      resourceReport: {
        dbSizeMB: 50,
        logSizeMB: 200,
        sessionSizeMB: 10,
        healthStatus: { status: 'ok', heapUsedMB: 100, heapTotalMB: 200 },
        concerns: [],
        checkedAt: '2026-03-22T00:00:00Z',
      },
      suiteUpdateReport: {
        suitesWithUpdates: [{ name: 'notifications', checkInstructions: 'Check grammy releases' }],
        suitesWithoutUpdates: ['email'],
        installedSuites: ['notifications', 'email'],
        checkedAt: '2026-03-22T00:00:00Z',
      },
      runDate: '2026-03-22T02:00:00Z',
    });

    expect(prompt).toContain('System Maintenance Agent');
    expect(prompt).toContain('Connection timeout');
    expect(prompt).toContain('5 occurrences');
    expect(prompt).toContain('old-service');
    expect(prompt).toContain('express');
    expect(prompt).toContain('4.18.0');
    expect(prompt).toContain('XSS');
    expect(prompt).toContain('50.0 MB');
    expect(prompt).toContain('notifications');
    expect(prompt).toContain('web search');
  });

  it('should handle empty data gracefully', async () => {
    const { buildMaintenancePrompt } = await import('../services/maintenance-agent.ts');

    const prompt = buildMaintenancePrompt({
      logAnalysis: { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 },
      dependencyReport: { outdated: [], vulnerabilities: [], checkedAt: '2026-03-22T00:00:00Z' },
      resourceReport: {
        dbSizeMB: 0,
        logSizeMB: 0,
        sessionSizeMB: 0,
        healthStatus: null,
        concerns: [],
        checkedAt: '2026-03-22T00:00:00Z',
      },
      suiteUpdateReport: {
        suitesWithUpdates: [],
        suitesWithoutUpdates: [],
        installedSuites: [],
        checkedAt: '2026-03-22T00:00:00Z',
      },
      runDate: '2026-03-22T02:00:00Z',
    });

    expect(prompt).toContain('No recurring errors');
    expect(prompt).toContain('All packages are up to date');
  });
});

// ---------- integration: maintenance-runner ----------

describe('maintenance-runner service (integration)', () => {
  let emittedEvents: any[];
  let eventHandlers: Record<string, Array<(event: any) => void>>;
  let mockEventBus: any;

  beforeEach(() => {
    emittedEvents = [];
    eventHandlers = {};
    mockEventBus = {
      emit: vi.fn((event: any) => {
        emittedEvents.push(event);
        // Auto-dispatch to registered handlers
        const handlers = eventHandlers[event.type] ?? [];
        for (const handler of handlers) {
          handler(event);
        }
      }),
      on: vi.fn((type: string, handler: any) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
      }),
      off: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register maintenance:run handler on start', async () => {
    vi.resetModules();
    const mod = await import('../services/maintenance-runner.ts');
    const service = mod.default;

    await service.start({
      eventBus: mockEventBus,
      db: {} as any,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: { port: 4001 },
      projectRoot: '/tmp/test',
      integrationsConfig: {} as any,
    });

    // Should have registered a handler for agent:task:request
    expect(mockEventBus.on).toHaveBeenCalledWith('agent:task:request', expect.any(Function));

    await service.stop();
  });
});
