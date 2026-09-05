import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTaskRequestEvent, RavenEvent } from '@raven/shared';
import { EventBus } from '../../../event-bus/event-bus.ts';
import { createJobRegistry } from '../../../scheduler/job-registry.ts';
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
  await service.start({
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
  });
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

  it('cleans its waiter when dispatch throws', async () => {
    bus.on('agent:task:request', () => {
      throw new Error('dispatch failed');
    });
    await expect(run()).rejects.toThrow('dispatch failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.report).not.toHaveBeenCalled();
  });
});
