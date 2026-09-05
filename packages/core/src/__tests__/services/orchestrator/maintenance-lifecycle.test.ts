import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTaskRequestEvent, RavenEvent } from '@raven/shared';
import { EventBus } from '../../../event-bus/event-bus.ts';
import { createJobRegistry } from '../../../scheduler/job-registry.ts';
import type { GeminiUploadCleanup } from '../../../services/gemini-transcription/upload-cleanup.ts';
import type { ServiceContext } from '../../../services/types.ts';
import service from '../../../services/orchestrator/maintenance-runner.ts';

const mocks = vi.hoisted(() => ({
  logs: vi.fn(),
  resources: vi.fn(),
  audit: vi.fn(),
  report: vi.fn(),
  notify: vi.fn(),
  knowledge: vi.fn(),
}));
vi.mock('../../../services/orchestrator/log-analyzer.ts', () => ({ analyzeLogs: mocks.logs }));
vi.mock('../../../services/orchestrator/dependency-checker.ts', () => ({
  checkDependencies: async () => ({}),
}));
vi.mock('../../../services/orchestrator/resource-monitor.ts', () => ({
  checkResources: mocks.resources,
}));
vi.mock('../../../services/orchestrator/convention-auditor.ts', () => ({
  auditConventions: mocks.audit,
}));
vi.mock('../../../services/orchestrator/maintenance-agent.ts', () => ({
  buildMaintenancePrompt: () => 'Analyze fixture',
}));
vi.mock('../../../services/orchestrator/maintenance-report.ts', () => ({
  compileReport: mocks.report,
  emitReportEvent: mocks.notify,
  sendReportNotification: mocks.notify,
}));

let root: string;
let bus: EventBus;
let jobs: ReturnType<typeof createJobRegistry>;
let serviceContext: ServiceContext;
let cleanup: GeminiUploadCleanup & {
  retryPending: Mock<GeminiUploadCleanup['retryPending']>;
  getReport: Mock<GeminiUploadCleanup['getReport']>;
};
beforeEach(async () => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'raven-maintenance-lifetime-'));
  bus = new EventBus();
  jobs = createJobRegistry();
  mocks.knowledge.mockResolvedValue(undefined);
  mocks.logs.mockResolvedValue({});
  mocks.resources.mockResolvedValue({});
  mocks.audit.mockResolvedValue({});
  mocks.report.mockResolvedValue({ filePath: join(root, 'report.md') });
  cleanup = {
    begin: () => {
      throw new Error('Maintenance cannot begin uploads');
    },
    observeUpload: () => {
      throw new Error('Maintenance cannot observe uploads');
    },
    finish: () => {
      throw new Error('Maintenance cannot finish uploads');
    },
    recoverInterrupted: () => {
      throw new Error('Maintenance cannot recover startup state');
    },
    stop: async () => {
      throw new Error('Maintenance does not own coordinator shutdown');
    },
    retryPending: vi.fn().mockResolvedValue({
      counts: { uploading: 0, active: 0, pending_delete: 1, unknown: 1, deleted: 2 },
      unresolved: [
        {
          id: 'attempt-1',
          status: 'pending_delete',
          correlationId: 'event-1',
          sourceFilePath: join(root, 'fixture.ogg'),
          remoteFileName: 'files/remote-1',
          attemptCount: 2,
          lastError: 'provider unavailable',
        },
      ],
      truncated: false,
    }),
    getReport: vi.fn(),
  };
  serviceContext = {
    eventBus: {
      on: (type, handler) => bus.on(type as RavenEvent['type'], handler),
      off: (type, handler) => bus.off(type as RavenEvent['type'], handler),
      emit: (event) => bus.emit(event as RavenEvent),
    },
    db: { run: vi.fn(), get: vi.fn(), all: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    config: { RAVEN_PORT: 4321 },
    projectRoot: root,
    projectsDir: join(root, 'definitions'),
    libraryDir: join(root, 'capabilities'),
    getApiPort: () => 4567,
    maintainKnowledge: mocks.knowledge,
    integrationsConfig: { ynab: { planId: '' }, accounts: [] },
    jobRegistry: jobs,
    geminiUploadCleanup: cleanup,
  };
  await service.start(serviceContext);
});
afterEach(async () => {
  await service.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const run = () => jobs.get('system-maintenance')!({ scheduleName: 'fixture', params: {} });

function requestPromise(): Promise<AgentTaskRequestEvent> {
  return new Promise((resolve) => bus.once<AgentTaskRequestEvent>('agent:task:request', resolve));
}

describe('maintenance lifetime', () => {
  it('uses the actual bound port and current definition roots, including synchronous model completion', async () => {
    bus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      bus.emit({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'fake',
        type: 'agent:task:complete',
        payload: {
          taskId: event.payload.taskId,
          result: 'Summary',
          durationMs: 0,
          success: true,
          skillName: 'orchestration',
        },
      });
    });
    await run();
    expect(mocks.resources).toHaveBeenCalledWith(
      join(root, 'data'),
      'http://localhost:4567/api/health',
    );
    expect(mocks.audit).toHaveBeenCalledWith({
      projectsDir: join(root, 'definitions'),
      libraryDir: join(root, 'capabilities'),
    });
    expect(mocks.knowledge).toHaveBeenCalledOnce();
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes failed knowledge repair in the maintenance report', async () => {
    mocks.knowledge.mockRejectedValue(new Error('graph disconnected'));
    bus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      bus.emit({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'fixture',
        type: 'agent:task:complete',
        payload: {
          taskId: event.payload.taskId,
          durationMs: 0,
          success: false,
          errors: ['analysis unavailable'],
          result: '',
        },
      });
    });
    await run();
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeMaintenanceError: 'Error: graph disconnected' }),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(cleanup.retryPending).toHaveBeenCalledOnce();
  });

  it('runs provider cleanup with knowledge and passes its report through', async () => {
    bus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      bus.emit({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'fixture',
        type: 'agent:task:complete',
        payload: {
          taskId: event.payload.taskId,
          result: 'Summary',
          durationMs: 0,
          success: true,
        },
      });
    });

    await run();

    expect(cleanup.retryPending).toHaveBeenCalledOnce();
    expect(mocks.report).toHaveBeenCalledWith(
      expect.objectContaining({
        geminiUploadCleanup: expect.objectContaining({
          counts: expect.objectContaining({ pending_delete: 1 }),
        }),
      }),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it('keeps a maintenance run bound to its service lifetime cleanup coordinator', async () => {
    let release!: (report: {
      counts: {
        uploading: number;
        active: number;
        pending_delete: number;
        unknown: number;
        deleted: number;
      };
      unresolved: [];
      truncated: boolean;
    }) => void;
    const oldRetry = new Promise<Parameters<typeof release>[0]>((resolve) => {
      release = resolve;
    });
    cleanup.retryPending.mockReturnValue(oldRetry);

    const oldRun = run();
    await vi.advanceTimersByTimeAsync(0);
    await service.stop();
    await expect(oldRun).rejects.toThrow('Maintenance stopped');

    const replacement = {
      ...cleanup,
      retryPending: vi.fn().mockResolvedValue({
        counts: { uploading: 0, active: 0, pending_delete: 0, unknown: 0, deleted: 1 },
        unresolved: [],
        truncated: false,
      }),
      getReport: vi.fn(),
    };
    serviceContext = { ...serviceContext, geminiUploadCleanup: replacement };
    await service.start(serviceContext);

    release({
      counts: { uploading: 0, active: 0, pending_delete: 1, unknown: 0, deleted: 0 },
      unresolved: [],
      truncated: false,
    });
    await Promise.resolve();
    expect(replacement.retryPending).not.toHaveBeenCalled();
  });

  it('removes completion waits on stop and does not write a fallback report', async () => {
    const requested = requestPromise();
    const pending = run();
    const settled = expect(pending).rejects.toThrow('Maintenance stopped');
    const request = await requested;
    expect(vi.getTimerCount()).toBe(1);
    await service.stop();
    await settled;
    expect(bus.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    bus.emit({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'fake',
      type: 'agent:task:complete',
      payload: {
        taskId: request.payload.taskId,
        skillName: 'orchestration',
        result: 'Late',
        durationMs: 0,
        success: true,
      },
    });
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('drains boundedly during an unfinished read and suppresses later work', async () => {
    let release!: () => void;
    mocks.logs.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = run();
    const settled = expect(pending).rejects.toThrow('Maintenance stopped');
    const stop = service.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stop;
    release();
    await settled;
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(bus.listenerCount()).toBe(0);
  });

  it('settles promptly when knowledge maintenance remains pending after stop', async () => {
    let release!: () => void;
    let knowledgeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      knowledgeStarted = resolve;
    });
    mocks.knowledge.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          knowledgeStarted();
        }),
    );

    const pending = run();
    await started;
    const settled = expect(pending).rejects.toThrow('Maintenance stopped');
    await service.stop();
    await settled;

    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(bus.listenerCount()).toBe(0);

    release();
    await Promise.resolve();
    expect(mocks.report).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('cleans its waiter when dispatch throws', async () => {
    bus.on('agent:task:request', () => {
      throw new Error('dispatch failed');
    });
    await expect(run()).rejects.toThrow('dispatch failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.report).not.toHaveBeenCalled();
  });
});
