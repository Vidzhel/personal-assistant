import { describe, it, expect } from 'vitest';

import {
  instantiateTemplate,
  interpolateString,
} from '../template-engine/template-instantiator.ts';
import type { TaskTemplate } from '@raven/shared';

function makeTemplate(overrides: Record<string, unknown> = {}): TaskTemplate {
  return {
    name: 'test-template',
    displayName: 'Test Template',
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

describe('interpolateString', () => {
  it('replaces single placeholder', () => {
    expect(interpolateString('Hello {{ name }}', { name: 'world' })).toBe('Hello world');
  });

  it('replaces multiple placeholders in same string', () => {
    const result = interpolateString('{{ greeting }} {{ name }}!', {
      greeting: 'Hello',
      name: 'world',
    });
    expect(result).toBe('Hello world!');
  });

  it('leaves unknown placeholders unchanged', () => {
    expect(interpolateString('{{ unknown }}', {})).toBe('{{ unknown }}');
  });

  it('handles whitespace in {{ param }}', () => {
    expect(interpolateString('{{  name  }}', { name: 'test' })).toBe('test');
    expect(interpolateString('{{name}}', { name: 'test' })).toBe('test');
    expect(interpolateString('{{   name   }}', { name: 'test' })).toBe('test');
  });
});

describe('param resolution', () => {
  it('resolves {{ param }} in prompt field', () => {
    const template = makeTemplate({
      params: { topic: { type: 'string', required: true } },
      tasks: [
        {
          id: 'research',
          type: 'agent',
          title: 'Research',
          prompt: 'Research {{ topic }} thoroughly',
          blockedBy: [],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, { topic: 'calculus' });
    expect(errors).toHaveLength(0);
    expect(nodes[0].type === 'agent' && nodes[0].prompt).toBe('Research calculus thoroughly');
  });

  it('resolves {{ param }} in title field', () => {
    const template = makeTemplate({
      params: { subject: { type: 'string', required: true } },
      tasks: [
        {
          id: 'study',
          type: 'agent',
          title: 'Study {{ subject }}',
          prompt: 'Study it',
          blockedBy: [],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, { subject: 'physics' });
    expect(errors).toHaveLength(0);
    expect(nodes[0].title).toBe('Study physics');
  });

  it('resolves nested params {{ param.field }}', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'task-1',
          type: 'agent',
          title: 'Task for {{ config.name }}',
          prompt: 'Use {{ config.setting }}',
          blockedBy: [],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {
      config: { name: 'MyApp', setting: 'fast-mode' },
    });
    expect(errors).toHaveLength(0);
    expect(nodes[0].title).toBe('Task for MyApp');
    expect(nodes[0].type === 'agent' && nodes[0].prompt).toBe('Use fast-mode');
  });

  it('missing required param returns error', () => {
    const template = makeTemplate({
      params: {
        topic: { type: 'string', required: true },
      },
    });

    const { nodes, errors } = instantiateTemplate(template, {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Missing required param');
    expect(errors[0]).toContain('topic');
    expect(nodes).toHaveLength(0);
  });

  it('optional param with default uses default value', () => {
    const template = makeTemplate({
      params: {
        mode: { type: 'string', required: false, default: 'standard' },
      },
      tasks: [
        {
          id: 'task-1',
          type: 'agent',
          title: 'Run in {{ mode }} mode',
          prompt: 'Go',
          blockedBy: [],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {});
    expect(errors).toHaveLength(0);
    expect(nodes[0].title).toBe('Run in standard mode');
  });

  it('unresolved runtime refs left as-is', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'summarize',
          type: 'agent',
          title: 'Summarize',
          prompt: 'Summarize {{ research.output }} into notes',
          blockedBy: [],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {});
    expect(errors).toHaveLength(0);
    expect(nodes[0].type === 'agent' && nodes[0].prompt).toBe(
      'Summarize {{ research.output }} into notes',
    );
  });
});

describe('forEach expansion', () => {
  it('expands task into N copies (one per item)', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'study',
          type: 'agent',
          title: 'Study {{ item }}',
          prompt: 'Study {{ item }}',
          blockedBy: [],
          forEach: '{{ subjects }}',
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {
      subjects: ['calculus', 'physics', 'english'],
    });
    expect(errors).toHaveLength(0);
    expect(nodes).toHaveLength(3);
  });

  it('generated IDs: "{originalId}-0", "{originalId}-1"', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'study',
          type: 'agent',
          title: 'Study {{ item }}',
          prompt: 'Study {{ item }}',
          blockedBy: [],
          forEach: '{{ subjects }}',
        },
      ],
    });

    const { nodes } = instantiateTemplate(template, {
      subjects: ['calculus', 'physics'],
    });
    expect(nodes[0].id).toBe('study-0');
    expect(nodes[1].id).toBe('study-1');
  });

  it('{{ item }} resolves to array element', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'study',
          type: 'agent',
          title: 'Study {{ item }}',
          prompt: 'Learn about {{ item }}',
          blockedBy: [],
          forEach: '{{ subjects }}',
        },
      ],
    });

    const { nodes } = instantiateTemplate(template, {
      subjects: ['calculus', 'physics'],
    });
    expect(nodes[0].title).toBe('Study calculus');
    expect(nodes[1].title).toBe('Study physics');
    expect(nodes[1].type === 'agent' && nodes[1].prompt).toBe('Learn about physics');
  });

  it('{{ item.field }} resolves to object field', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'email',
          type: 'agent',
          title: 'Email {{ item.name }}',
          prompt: 'Send email to {{ item.address }}',
          blockedBy: [],
          forEach: '{{ contacts }}',
        },
      ],
    });

    const { nodes } = instantiateTemplate(template, {
      contacts: [
        { name: 'Alice', address: 'alice@example.com' },
        { name: 'Bob', address: 'bob@example.com' },
      ],
    });
    expect(nodes[0].title).toBe('Email Alice');
    expect(nodes[1].type === 'agent' && nodes[1].prompt).toBe('Send email to bob@example.com');
  });

  it('blockedBy references to forEach task expand to all generated IDs', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'study',
          type: 'agent',
          title: 'Study {{ item }}',
          prompt: 'Study {{ item }}',
          blockedBy: [],
          forEach: '{{ subjects }}',
        },
        {
          id: 'summarize',
          type: 'agent',
          title: 'Summarize all',
          prompt: 'Summarize everything',
          blockedBy: ['study'],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {
      subjects: ['calculus', 'physics', 'english'],
    });
    expect(errors).toHaveLength(0);

    const summarize = nodes.find((n) => n.id === 'summarize');
    expect(summarize).toBeDefined();
    expect(summarize!.blockedBy).toEqual(['study-0', 'study-1', 'study-2']);
  });

  it('non-array forEach source returns error', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'study',
          type: 'agent',
          title: 'Study',
          prompt: 'Study',
          blockedBy: [],
          forEach: '{{ subjects }}',
        },
      ],
    });

    const { errors } = instantiateTemplate(template, { subjects: 'not-an-array' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('did not resolve to an array');
  });
});

describe('full instantiation', () => {
  it('complete template with params + forEach produces valid TaskTreeNodes', () => {
    const template = makeTemplate({
      params: {
        course: { type: 'string', required: true },
      },
      tasks: [
        {
          id: 'gather',
          type: 'agent',
          title: 'Gather {{ course }} materials',
          prompt: 'Find materials for {{ course }}',
          blockedBy: [],
        },
        {
          id: 'study',
          type: 'agent',
          title: 'Study {{ item }}',
          prompt: 'Study {{ item }} for {{ course }}',
          blockedBy: ['gather'],
          forEach: '{{ topics }}',
        },
        {
          id: 'review',
          type: 'agent',
          title: 'Review {{ course }}',
          prompt: 'Review all topics',
          blockedBy: ['study'],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {
      course: 'Math',
      topics: ['algebra', 'geometry'],
    });

    expect(errors).toHaveLength(0);
    expect(nodes).toHaveLength(4); // gather + study-0 + study-1 + review

    expect(nodes[0].id).toBe('gather');
    expect(nodes[0].title).toBe('Gather Math materials');

    expect(nodes[1].id).toBe('study-0');
    expect(nodes[1].title).toBe('Study algebra');
    expect(nodes[1].type === 'agent' && nodes[1].prompt).toBe('Study algebra for Math');

    expect(nodes[2].id).toBe('study-1');
    expect(nodes[2].title).toBe('Study geometry');

    // blockedBy for review should be expanded
    expect(nodes[3].blockedBy).toEqual(['study-0', 'study-1']);
  });

  it('tasks without forEach pass through unchanged', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'simple',
          type: 'agent',
          title: 'Simple Task',
          prompt: 'Do it',
          blockedBy: [],
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {});
    expect(errors).toHaveLength(0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('simple');
    expect(nodes[0].title).toBe('Simple Task');
  });

  it('validation config preserved on expanded tasks', () => {
    const template = makeTemplate({
      tasks: [
        {
          id: 'study',
          type: 'agent',
          title: 'Study {{ item }}',
          prompt: 'Study {{ item }}',
          blockedBy: [],
          forEach: '{{ subjects }}',
          validation: {
            requireArtifacts: true,
            evaluator: true,
            evaluatorModel: 'haiku',
            qualityReview: false,
            qualityModel: 'sonnet',
            qualityThreshold: 3,
            maxRetries: 2,
            retryBackoffMs: 1000,
            onMaxRetriesFailed: 'escalate',
          },
        },
      ],
    });

    const { nodes, errors } = instantiateTemplate(template, {
      subjects: ['math', 'science'],
    });
    expect(errors).toHaveLength(0);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].validation).toBeDefined();
    expect(nodes[0].validation!.requireArtifacts).toBe(true);
    expect(nodes[1].validation).toBeDefined();
    expect(nodes[1].validation!.evaluator).toBe(true);
  });
});
