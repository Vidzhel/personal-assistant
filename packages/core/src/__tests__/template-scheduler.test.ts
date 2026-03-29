import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createTemplateScheduler,
  type TemplateScheduler,
} from '../template-engine/template-scheduler.ts';
import type { TaskTemplate } from '@raven/shared';
import type { TemplateRegistry } from '../template-engine/template-registry.ts';
import type { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { EventBusInterface } from '@raven/shared';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTemplate(overrides: Record<string, unknown> = {}): TaskTemplate {
  return {
    name: 'test-template',
    displayName: 'Test Template',
    description: 'A test template',
    params: {},
    trigger: [{ type: 'manual' }],
    plan: { approval: 'manual', parallel: true },
    tasks: [
      {
        id: 'task-1',
        type: 'agent',
        title: 'Default Task',
        prompt: 'Do something',
        blockedBy: [],
      },
    ],
    ...overrides,
  } as unknown as TaskTemplate;
}

function createMockDeps(): {
  templateRegistry: TemplateRegistry;
  executionEngine: TaskExecutionEngine;
  eventBus: EventBusInterface;
} {
  const eventHandlers = new Map<string, Array<(event: unknown) => void>>();

  return {
    templateRegistry: {
      getAllTemplates: vi.fn(() => []),
      getTemplate: vi.fn(),
      listTemplates: vi.fn(() => []),
      load: vi.fn(),
    } as unknown as TemplateRegistry,
    executionEngine: {
      createTree: vi.fn(() => ({ id: 'tree-1', status: 'pending_approval', tasks: new Map() })),
      startTree: vi.fn(async () => {}),
      getTree: vi.fn(),
      getActiveTrees: vi.fn(() => []),
    } as unknown as TaskExecutionEngine,
    eventBus: {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: (event: unknown) => void) => {
        if (!eventHandlers.has(type)) eventHandlers.set(type, []);
        eventHandlers.get(type)!.push(handler);
      }),
      off: vi.fn((type: string, handler: (event: unknown) => void) => {
        const handlers = eventHandlers.get(type);
        if (handlers) {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }
      }),
      _emit: (type: string, event: unknown) => {
        const handlers = eventHandlers.get(type);
        if (handlers) {
          for (const h of handlers) h(event);
        }
      },
    } as unknown as EventBusInterface,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('createTemplateScheduler', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let scheduler: TemplateScheduler;

  beforeEach(() => {
    deps = createMockDeps();
  });

  afterEach(() => {
    if (scheduler) scheduler.stop();
  });

  it('registers cron jobs for schedule-triggered templates', () => {
    const template = makeTemplate({
      name: 'cron-template',
      trigger: [{ type: 'schedule', cron: '0 6 * * *', timezone: 'UTC' }],
    });
    vi.mocked(deps.templateRegistry.getAllTemplates).mockReturnValue([template]);

    scheduler = createTemplateScheduler(deps);
    scheduler.start();

    // No immediate tree creation — cron hasn't fired
    expect(deps.executionEngine.createTree).not.toHaveBeenCalled();
  });

  it('does NOT register cron for manual-only templates', () => {
    const template = makeTemplate({
      name: 'manual-template',
      trigger: [{ type: 'manual' }],
    });
    vi.mocked(deps.templateRegistry.getAllTemplates).mockReturnValue([template]);

    scheduler = createTemplateScheduler(deps);
    scheduler.start();

    // No event handler registered either
    expect(deps.eventBus.on).not.toHaveBeenCalled();
  });

  it('registers event handlers for event-triggered templates', () => {
    const template = makeTemplate({
      name: 'event-template',
      trigger: [{ type: 'event', eventType: 'email:received' }],
    });
    vi.mocked(deps.templateRegistry.getAllTemplates).mockReturnValue([template]);

    scheduler = createTemplateScheduler(deps);
    scheduler.start();

    expect(deps.eventBus.on).toHaveBeenCalledWith('email:received', expect.any(Function));
  });

  it('triggerTemplate() creates and starts a task tree with auto-approval', async () => {
    const template = makeTemplate({
      name: 'auto-template',
      plan: { approval: 'auto', parallel: true },
    });
    vi.mocked(deps.templateRegistry.getTemplate).mockReturnValue(template);

    scheduler = createTemplateScheduler(deps);
    const treeId = await scheduler.triggerTemplate('auto-template');

    expect(treeId).toBeTruthy();
    expect(deps.executionEngine.createTree).toHaveBeenCalledWith(
      expect.objectContaining({
        id: treeId,
        tasks: expect.arrayContaining([expect.objectContaining({ id: 'task-1', type: 'agent' })]),
      }),
    );
    // Auto-approval triggers startTree
    expect(deps.executionEngine.startTree).toHaveBeenCalledWith(treeId);
  });

  it('triggerTemplate() with manual-approval leaves tree pending', async () => {
    const template = makeTemplate({
      name: 'manual-template',
      plan: { approval: 'manual', parallel: true },
    });
    vi.mocked(deps.templateRegistry.getTemplate).mockReturnValue(template);

    scheduler = createTemplateScheduler(deps);
    const treeId = await scheduler.triggerTemplate('manual-template');

    expect(treeId).toBeTruthy();
    expect(deps.executionEngine.createTree).toHaveBeenCalled();
    expect(deps.executionEngine.startTree).not.toHaveBeenCalled();
  });

  it('triggerTemplate() throws for unknown template', async () => {
    vi.mocked(deps.templateRegistry.getTemplate).mockReturnValue(undefined);

    scheduler = createTemplateScheduler(deps);
    await expect(scheduler.triggerTemplate('nonexistent')).rejects.toThrow(
      'Template not found: "nonexistent"',
    );
  });

  it('stop() stops all cron jobs and unregisters event handlers', () => {
    const cronTemplate = makeTemplate({
      name: 'cron-t',
      trigger: [{ type: 'schedule', cron: '0 * * * *', timezone: 'UTC' }],
    });
    const eventTemplate = makeTemplate({
      name: 'event-t',
      trigger: [{ type: 'event', eventType: 'test:event' }],
    });
    vi.mocked(deps.templateRegistry.getAllTemplates).mockReturnValue([cronTemplate, eventTemplate]);

    scheduler = createTemplateScheduler(deps);
    scheduler.start();

    expect(deps.eventBus.on).toHaveBeenCalledTimes(1);

    scheduler.stop();

    // Event handler should be unregistered
    expect(deps.eventBus.off).toHaveBeenCalledWith('test:event', expect.any(Function));
  });

  it('event trigger creates a tree when event fires', () => {
    const template = makeTemplate({
      name: 'event-template',
      trigger: [{ type: 'event', eventType: 'email:received' }],
      plan: { approval: 'auto', parallel: true },
    });
    vi.mocked(deps.templateRegistry.getAllTemplates).mockReturnValue([template]);

    scheduler = createTemplateScheduler(deps);
    scheduler.start();

    // Simulate event
    const busWithEmit = deps.eventBus as unknown as {
      _emit: (type: string, event: unknown) => void;
    };
    busWithEmit._emit('email:received', { type: 'email:received', payload: {} });

    expect(deps.executionEngine.createTree).toHaveBeenCalled();
    expect(deps.executionEngine.startTree).toHaveBeenCalled();
  });
});
