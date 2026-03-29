import { describe, it, expect } from 'vitest';
import {
  TaskTemplateSchema,
  TemplateParamSchema,
  TemplateTriggerSchema,
  TemplateTaskSchema,
} from '../types/templates.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function makeAgentTask(overrides = {}) {
  return {
    type: 'agent',
    id: 'step-1',
    title: 'Do research',
    prompt: 'Find relevant data',
    ...overrides,
  };
}

function makeMinimalTemplate(overrides = {}) {
  return {
    name: 'daily-digest',
    displayName: 'Daily Digest',
    tasks: [makeAgentTask()],
    ...overrides,
  };
}

// ── TaskTemplateSchema ─────────────────────────────────────────────────

describe('TaskTemplateSchema', () => {
  it('validates a template with agent tasks', () => {
    const result = TaskTemplateSchema.parse(makeMinimalTemplate());
    expect(result.name).toBe('daily-digest');
    expect(result.displayName).toBe('Daily Digest');
    expect(result.tasks).toHaveLength(1);
  });

  it('validates a template with mixed task types', () => {
    const result = TaskTemplateSchema.parse(
      makeMinimalTemplate({
        tasks: [
          makeAgentTask(),
          {
            type: 'code',
            id: 'run-script',
            title: 'Process data',
            script: './process.sh',
          },
          {
            type: 'condition',
            id: 'check-output',
            title: 'Verify output',
            expression: 'artifacts.length > 0',
          },
          {
            type: 'notify',
            id: 'send-alert',
            title: 'Notify user',
            channel: 'telegram',
            message: 'Done!',
          },
        ],
      }),
    );
    expect(result.tasks).toHaveLength(4);
  });

  it('applies default values for plan, trigger, and params', () => {
    const result = TaskTemplateSchema.parse(makeMinimalTemplate());
    expect(result.plan.approval).toBe('manual');
    expect(result.plan.parallel).toBe(true);
    expect(result.trigger).toEqual([{ type: 'manual' }]);
    expect(result.params).toEqual({});
  });

  it('rejects empty tasks array', () => {
    expect(() => TaskTemplateSchema.parse(makeMinimalTemplate({ tasks: [] }))).toThrow();
  });

  it('rejects invalid task type', () => {
    expect(() =>
      TaskTemplateSchema.parse(
        makeMinimalTemplate({
          tasks: [{ type: 'unknown', id: 'bad', title: 'Bad' }],
        }),
      ),
    ).toThrow();
  });

  it('rejects non-kebab-case name', () => {
    expect(() => TaskTemplateSchema.parse(makeMinimalTemplate({ name: 'CamelCase' }))).toThrow();
    expect(() => TaskTemplateSchema.parse(makeMinimalTemplate({ name: 'has spaces' }))).toThrow();
  });
});

// ── TemplateParamSchema ────────────────────────────────────────────────

describe('TemplateParamSchema', () => {
  it('validates string param with defaults', () => {
    const result = TemplateParamSchema.parse({ type: 'string' });
    expect(result.type).toBe('string');
    expect(result.required).toBe(true);
  });

  it('validates number param with default value', () => {
    const result = TemplateParamSchema.parse({
      type: 'number',
      required: false,
      default: 42,
      description: 'Max items',
    });
    expect(result.type).toBe('number');
    expect(result.required).toBe(false);
    expect(result.default).toBe(42);
  });

  it('validates boolean param', () => {
    const result = TemplateParamSchema.parse({
      type: 'boolean',
      default: true,
    });
    expect(result.type).toBe('boolean');
    expect(result.default).toBe(true);
  });

  it('rejects invalid param type', () => {
    expect(() => TemplateParamSchema.parse({ type: 'object' })).toThrow();
  });
});

// ── TemplateTriggerSchema ──────────────────────────────────────────────

describe('TemplateTriggerSchema', () => {
  it('validates manual trigger', () => {
    const result = TemplateTriggerSchema.parse({ type: 'manual' });
    expect(result.type).toBe('manual');
  });

  it('validates schedule trigger with cron', () => {
    const result = TemplateTriggerSchema.parse({
      type: 'schedule',
      cron: '0 9 * * *',
    });
    expect(result.type).toBe('schedule');
    if (result.type === 'schedule') {
      expect(result.cron).toBe('0 9 * * *');
      expect(result.timezone).toBe('UTC');
    }
  });

  it('validates event trigger with eventType', () => {
    const result = TemplateTriggerSchema.parse({
      type: 'event',
      eventType: 'email:received',
      filter: { from: 'boss@example.com' },
    });
    expect(result.type).toBe('event');
    if (result.type === 'event') {
      expect(result.eventType).toBe('email:received');
      expect(result.filter).toEqual({ from: 'boss@example.com' });
    }
  });

  it('rejects invalid trigger type', () => {
    expect(() => TemplateTriggerSchema.parse({ type: 'webhook' })).toThrow();
  });
});

// ── TemplateTaskSchema (forEach extension) ─────────────────────────────

describe('TemplateTaskSchema (forEach)', () => {
  it('validates a task with forEach', () => {
    const result = TemplateTaskSchema.parse({
      ...makeAgentTask(),
      forEach: 'params.items',
      forEachAs: 'currentItem',
    });
    expect(result.forEach).toBe('params.items');
    expect(result.forEachAs).toBe('currentItem');
  });

  it('applies forEachAs default when forEach is set', () => {
    const result = TemplateTaskSchema.parse({
      ...makeAgentTask(),
      forEach: 'params.emails',
    });
    expect(result.forEach).toBe('params.emails');
    expect(result.forEachAs).toBe('item');
  });

  it('works without forEach fields', () => {
    const result = TemplateTaskSchema.parse(makeAgentTask());
    expect(result.forEach).toBeUndefined();
    expect(result.forEachAs).toBe('item');
  });
});
