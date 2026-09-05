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
import { auditConventions } from './convention-auditor.ts';
import { buildMaintenancePrompt } from './maintenance-agent.ts';
import { compileReport, emitReportEvent, sendReportNotification } from './maintenance-report.ts';

const log = createLogger('maintenance-runner');

const DEFAULT_PORT = 4001;

let eventBus: EventBusInterface;
let projectRoot: string;
let projectsDir: string;
let libraryDir: string;
let getPort: () => number;
let maintainKnowledge: ServiceContext['maintainKnowledge'];
let lifetime: AbortController | undefined;
let requestHandler: ((event: unknown) => void) | undefined;
let activeRun: Promise<void> | undefined;
let port: number;
let running = false;

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    if (lifetime) await service.stop();
    eventBus = context.eventBus;
    projectRoot = context.projectRoot;
    projectsDir = context.projectsDir ?? resolve(context.projectRoot, 'projects');
    libraryDir = context.libraryDir ?? resolve(context.projectRoot, 'library');
    port = (context.config.RAVEN_PORT as number) ?? DEFAULT_PORT;
    getPort = context.getApiPort ?? (() => port);
    maintainKnowledge = context.maintainKnowledge;
    lifetime = new AbortController();
    const current = lifetime;
    running = false;
    activeRun = undefined;

    // Listen for agent:task:complete events from pipeline nodes that trigger maintenance
    requestHandler = (event: unknown) => {
      const payload = (event as { payload: unknown }).payload as {
        actionName?: string;
        taskId: string;
      };
      if (payload.actionName === 'maintenance:run') {
        startRun(payload.taskId, current.signal).catch((err) => {
          if (current.signal.aborted) return;
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
    };

    context.jobRegistry.register('system-maintenance', async () => {
      await startRun(generateId(), current.signal);
      return { summary: 'System maintenance complete' };
    });

    eventBus.on('agent:task:request', requestHandler);
    log.info('Maintenance runner service started');
  },

  async stop(): Promise<void> {
    lifetime?.abort(new Error('Maintenance stopped'));
    if (requestHandler) eventBus.off('agent:task:request', requestHandler);
    requestHandler = undefined;
    const DRAIN_TIMEOUT_MS = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      activeRun?.catch(() => {}),
      new Promise<void>((resolveDrain) => {
        timer = setTimeout(resolveDrain, DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    log.info('Maintenance runner service stopped');
  },
};

export default service;

interface GatheredMaintenanceData {
  logAnalysis: Awaited<ReturnType<typeof analyzeLogs>>;
  dependencyReport: Awaited<ReturnType<typeof checkDependencies>>;
  resourceReport: Awaited<ReturnType<typeof checkResources>>;
  conventionAuditReport: Awaited<ReturnType<typeof auditConventions>>;
  knowledgeMaintenance?: Awaited<ReturnType<NonNullable<ServiceContext['maintainKnowledge']>>>;
  knowledgeMaintenanceError?: string;
}

/** Let a scheduled run settle when its service lifetime ends while observing
 * the underlying operation until it eventually resolves. The maintenance
 * processors own their resources and may finish in the background; every
 * caller here checks the same signal before reporting or writing results. */
async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    operation.catch(() => {});
    throw signal.reason ?? new Error('Maintenance stopped');
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<T>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Maintenance stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function gatherMaintenanceData(signal: AbortSignal): Promise<GatheredMaintenanceData> {
  const logDir = getLogDir() ?? resolve(projectRoot, 'data/logs');
  const dataDir = resolve(projectRoot, 'data');
  const healthUrl = `http://localhost:${String(getPort())}/api/health`;

  const [logAnalysis, dependencyReport, resourceReport, conventionAuditReport] = await Promise.all([
    analyzeLogs(logDir),
    checkDependencies(projectRoot),
    checkResources(dataDir, healthUrl),
    auditConventions({ projectsDir, libraryDir }),
  ]);

  signal.throwIfAborted();
  let knowledgeMaintenance;
  let knowledgeMaintenanceError;
  try {
    knowledgeMaintenance = await maintainKnowledge?.();
  } catch (error) {
    signal.throwIfAborted();
    knowledgeMaintenanceError = String(error);
  }
  return {
    knowledgeMaintenance,
    knowledgeMaintenanceError,
    logAnalysis,
    dependencyReport,
    resourceReport,
    conventionAuditReport,
  };
}

// Spawns a Claude sub-agent for analysis via agent:task:request and awaits its result.
async function requestAgentAnalysis(prompt: string, signal: AbortSignal): Promise<string | null> {
  const analysisTaskId = generateId();
  const dispatch = new AbortController();
  const analysisPromise = waitForAnalysis(
    analysisTaskId,
    AbortSignal.any([signal, dispatch.signal]),
  );

  try {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_MAINTENANCE,
      type: 'agent:task:request',
      payload: {
        taskId: analysisTaskId,
        prompt,
        // L17: must match the library skill name (library/skills/system/
        // orchestration/config.json) — 'orchestrator' isn't a library-known
        // skill, so resolveTier(actionName) would fall back to 'red' if this
        // task ever carried an actionName (it doesn't today, but skillName is
        // also used for MCP/agent-definition resolution — see agent-manager.ts).
        skillName: 'orchestration',
        mcpServers: {},
        priority: 'normal',
      },
    });
  } catch (err) {
    dispatch.abort(err);
  }
  return analysisPromise;
}

function startRun(taskId: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted || signal !== lifetime?.signal)
    return Promise.reject(new Error('Maintenance stopped'));
  if (running) return Promise.reject(new Error('Maintenance already running'));
  activeRun = runMaintenance(taskId, signal);
  return activeRun;
}

async function runMaintenance(taskId: string, signal: AbortSignal): Promise<void> {
  if (running) {
    log.warn('Maintenance already running, skipping');
    return;
  }

  running = true;
  const startTime = Date.now();
  log.info('Starting maintenance run');

  try {
    // Phase 1: Gather data from all modules in parallel
    const data = await awaitWithAbort(gatherMaintenanceData(signal), signal);
    signal.throwIfAborted();
    log.info('Data gathering complete, building agent prompt');

    // Phase 2: Build prompt for the maintenance agent
    const prompt = buildMaintenancePrompt({ ...data, runDate: new Date().toISOString() });

    // Phase 3: Spawn a Claude sub-agent for analysis via agent:task:request
    const analysisResult = await requestAgentAnalysis(prompt, signal);
    signal.throwIfAborted();

    // Phase 4: Compile report (use agent analysis if available, fallback to data-only report)
    const reportsDir = resolve(projectRoot, 'data', 'maintenance-reports');
    const report = await compileReport(
      { ...data, agentAnalysis: analysisResult ?? undefined },
      reportsDir,
      signal,
    );
    signal.throwIfAborted();

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
    if (lifetime?.signal === signal) running = false;
  }
}

function waitForAnalysis(taskId: string, signal: AbortSignal): Promise<string | null> {
  const ANALYSIS_TIMEOUT_MS = 300_000; // 5 minutes

  return new Promise((resolve, reject) => {
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

    function onAbort(): void {
      cleanup();
      reject(signal.reason);
    }
    function cleanup(): void {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timeout);
      eventBus.off('agent:task:complete', handler);
    }

    eventBus.on('agent:task:complete', handler);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
