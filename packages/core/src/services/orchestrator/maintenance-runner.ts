import { resolve } from 'node:path';
import {
  createLogger,
  generateId,
  getLogDir,
  SOURCE_MAINTENANCE,
  type EventBusInterface,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import { analyzeLogs } from './log-analyzer.ts';
import { checkDependencies } from './dependency-checker.ts';
import { checkResources } from './resource-monitor.ts';
import { checkSuiteUpdates } from './suite-update-checker.ts';
import { auditConventions } from './convention-auditor.ts';
import { buildMaintenancePrompt } from './maintenance-agent.ts';
import { compileReport, emitReportEvent, sendReportNotification } from './maintenance-report.ts';

const log = createLogger('maintenance-runner');

const DEFAULT_PORT = 4001;

let eventBus: EventBusInterface;
let projectRoot: string;
let port: number;
let running = false;

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    projectRoot = context.projectRoot;
    port = (context.config.port as number) ?? DEFAULT_PORT;

    // Listen for agent:task:complete events from pipeline nodes that trigger maintenance
    eventBus.on('agent:task:request', (event: unknown) => {
      const payload = (event as { payload: unknown }).payload as {
        actionName?: string;
        taskId: string;
      };
      if (payload.actionName === 'maintenance:run') {
        runMaintenance(payload.taskId).catch((err) => {
          log.error(`Maintenance run failed: ${err instanceof Error ? err.message : String(err)}`);
          // Emit completion so pipeline doesn't hang
          eventBus.emit({
            id: generateId(),
            timestamp: Date.now(),
            source: SOURCE_MAINTENANCE,
            type: 'agent:task:complete',
            payload: {
              taskId: payload.taskId,
              result: `Maintenance failed: ${err instanceof Error ? err.message : String(err)}`,
              durationMs: 0,
              success: false,
              errors: [err instanceof Error ? err.message : String(err)],
            },
          });
        });
      }
    });

    context.jobRegistry.register('system-maintenance', async () => {
      await runMaintenance(generateId());
      return { summary: 'System maintenance complete' };
    });

    log.info('Maintenance runner service started');
  },

  async stop(): Promise<void> {
    log.info('Maintenance runner service stopped');
  },
};

export default service;

interface GatheredMaintenanceData {
  logAnalysis: Awaited<ReturnType<typeof analyzeLogs>>;
  dependencyReport: Awaited<ReturnType<typeof checkDependencies>>;
  resourceReport: Awaited<ReturnType<typeof checkResources>>;
  suiteUpdateReport: Awaited<ReturnType<typeof checkSuiteUpdates>>;
  conventionAuditReport: Awaited<ReturnType<typeof auditConventions>>;
}

async function gatherMaintenanceData(): Promise<GatheredMaintenanceData> {
  const logDir = getLogDir() ?? resolve(projectRoot, 'data/logs');
  const dataDir = resolve(projectRoot, 'data');
  const suitesDir = resolve(projectRoot, 'suites');
  const healthUrl = `http://localhost:${String(port)}/api/health`;
  const configDir = resolve(projectRoot, 'config');

  const [logAnalysis, dependencyReport, resourceReport, suiteUpdateReport, conventionAuditReport] =
    await Promise.all([
      analyzeLogs(logDir),
      checkDependencies(projectRoot),
      checkResources(dataDir, healthUrl),
      checkSuiteUpdates(suitesDir),
      auditConventions(suitesDir, configDir),
    ]);

  return {
    logAnalysis,
    dependencyReport,
    resourceReport,
    suiteUpdateReport,
    conventionAuditReport,
  };
}

// Spawns a Claude sub-agent for analysis via agent:task:request and awaits its result.
async function requestAgentAnalysis(prompt: string): Promise<string | null> {
  const analysisTaskId = generateId();
  const analysisPromise = waitForAnalysis(analysisTaskId);

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_MAINTENANCE,
    type: 'agent:task:request',
    payload: {
      taskId: analysisTaskId,
      prompt,
      skillName: 'orchestrator',
      mcpServers: {},
      priority: 'normal',
    },
  });

  return analysisPromise;
}

async function runMaintenance(taskId: string): Promise<void> {
  if (running) {
    log.warn('Maintenance already running, skipping');
    return;
  }

  running = true;
  const startTime = Date.now();
  log.info('Starting maintenance run');

  try {
    // Phase 1: Gather data from all modules in parallel
    const data = await gatherMaintenanceData();
    log.info('Data gathering complete, building agent prompt');

    // Phase 2: Build prompt for the maintenance agent
    const prompt = buildMaintenancePrompt({ ...data, runDate: new Date().toISOString() });

    // Phase 3: Spawn a Claude sub-agent for analysis via agent:task:request
    const analysisResult = await requestAgentAnalysis(prompt);

    // Phase 4: Compile report (use agent analysis if available, fallback to data-only report)
    const reportsDir = resolve(projectRoot, 'data', 'maintenance-reports');
    const report = await compileReport(
      { ...data, agentAnalysis: analysisResult ?? undefined },
      reportsDir,
    );

    // Phase 5: Emit event and send notification
    emitReportEvent(eventBus, report);
    sendReportNotification(eventBus, report);

    const durationMs = Date.now() - startTime;
    log.info(`Maintenance run complete in ${String(durationMs)}ms`);

    // Signal pipeline completion
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_MAINTENANCE,
      type: 'agent:task:complete',
      payload: {
        taskId,
        result: `Maintenance report generated: ${report.filePath}`,
        durationMs,
        success: true,
      },
    });
  } finally {
    running = false;
  }
}

function waitForAnalysis(taskId: string): Promise<string | null> {
  const ANALYSIS_TIMEOUT_MS = 300_000; // 5 minutes

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log.warn('Analysis agent timed out, using fallback report');
      cleanup();
      resolve(null);
    }, ANALYSIS_TIMEOUT_MS);

    function handler(event: unknown): void {
      const e = event as {
        payload: { taskId: string; result?: string; success?: boolean };
      };
      if (e.payload.taskId !== taskId) return;
      cleanup();

      if (e.payload.success && e.payload.result) {
        resolve(e.payload.result);
      } else {
        log.warn('Analysis agent failed, using fallback report');
        resolve(null);
      }
    }

    function cleanup(): void {
      clearTimeout(timeout);
      eventBus.off('agent:task:complete', handler);
    }

    eventBus.on('agent:task:complete', handler);
  });
}
