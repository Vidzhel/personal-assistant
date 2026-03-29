import { describe, it, expect } from 'vitest';
import { buildTriageInstructions, parseTriageResponse } from '../task-execution/plan-builder.ts';

describe('buildTriageInstructions', () => {
  it('includes DIRECT, DELEGATED, PLANNED descriptions', () => {
    const result = buildTriageInstructions(['ticktick', 'gmail'], []);

    expect(result).toContain('**DIRECT**');
    expect(result).toContain('**DELEGATED**');
    expect(result).toContain('**PLANNED**');
    expect(result).toContain('Execution Mode Classification');
  });

  it('includes available agents list', () => {
    const result = buildTriageInstructions(['ticktick', 'gmail'], []);

    expect(result).toContain('Available agents: ticktick, gmail');
  });

  it('includes available templates list', () => {
    const result = buildTriageInstructions([], ['weekly-review', 'inbox-triage']);

    expect(result).toContain('Available templates: weekly-review, inbox-triage');
  });

  it('shows "none" when no agents or templates available', () => {
    const result = buildTriageInstructions([], []);

    expect(result).toContain('Available agents: none');
    expect(result).toContain('Available templates: none');
  });
});

describe('parseTriageResponse', () => {
  it('defaults to direct for normal text response', () => {
    const result = parseTriageResponse('Here are your tasks for today: ...');

    expect(result.mode).toBe('direct');
    expect(result.planDescription).toBeUndefined();
    expect(result.taskTree).toBeUndefined();
  });

  it('parses PLANNED response with valid JSON in code block', () => {
    const response = [
      'EXECUTION_MODE: PLANNED',
      "PLAN_DESCRIPTION: Prepare for tomorrow's exam by gathering materials and creating a study plan",
      'TASK_TREE:',
      '```json',
      JSON.stringify(
        [
          {
            id: 'step-1',
            title: 'Gather materials',
            type: 'agent',
            agent: 'ticktick',
            prompt: 'Find exam-related tasks',
            blockedBy: [],
          },
          {
            id: 'step-2',
            title: 'Create study plan',
            type: 'agent',
            agent: 'gmail',
            prompt: 'Draft study schedule',
            blockedBy: ['step-1'],
          },
          {
            id: 'notify',
            title: 'Send summary',
            type: 'notify',
            channel: 'telegram',
            message: 'Study plan ready',
            blockedBy: ['step-2'],
          },
        ],
        null,
        2,
      ),
      '```',
    ].join('\n');

    const result = parseTriageResponse(response);

    expect(result.mode).toBe('planned');
    expect(result.taskTree).toHaveLength(3);
    expect(result.taskTree![0].id).toBe('step-1');
    expect(result.taskTree![0].type).toBe('agent');
    expect(result.taskTree![2].type).toBe('notify');
  });

  it('extracts plan description', () => {
    const response = [
      'EXECUTION_MODE: PLANNED',
      'PLAN_DESCRIPTION: Set up weekly review workflow',
      'TASK_TREE:',
      '```json',
      JSON.stringify([
        {
          id: 'step-1',
          title: 'Review tasks',
          type: 'agent',
          agent: 'ticktick',
          prompt: 'List all tasks',
          blockedBy: [],
        },
      ]),
      '```',
    ].join('\n');

    const result = parseTriageResponse(response);

    expect(result.mode).toBe('planned');
    expect(result.planDescription).toBe('Set up weekly review workflow');
  });

  it('defaults to direct for malformed JSON', () => {
    const response = [
      'EXECUTION_MODE: PLANNED',
      'PLAN_DESCRIPTION: Some plan',
      'TASK_TREE:',
      '```json',
      '{ this is not valid json }',
      '```',
    ].join('\n');

    const result = parseTriageResponse(response);

    expect(result.mode).toBe('direct');
  });

  it('defaults to direct when task tree nodes fail validation', () => {
    const response = [
      'EXECUTION_MODE: PLANNED',
      'PLAN_DESCRIPTION: Some plan',
      'TASK_TREE:',
      '```json',
      JSON.stringify([{ id: 'step-1', title: 'Do thing', type: 'unknown_type', blockedBy: [] }]),
      '```',
    ].join('\n');

    const result = parseTriageResponse(response);

    expect(result.mode).toBe('direct');
  });

  it('parses PLANNED response with bare JSON (no code block)', () => {
    const response = [
      'EXECUTION_MODE: PLANNED',
      'PLAN_DESCRIPTION: Quick plan',
      'TASK_TREE:',
      JSON.stringify([
        {
          id: 'step-1',
          title: 'Do it',
          type: 'agent',
          agent: 'ticktick',
          prompt: 'Do the thing',
          blockedBy: [],
        },
      ]),
    ].join('\n');

    const result = parseTriageResponse(response);

    expect(result.mode).toBe('planned');
    expect(result.taskTree).toHaveLength(1);
  });

  it('validates task tree nodes against schema', () => {
    const response = [
      'EXECUTION_MODE: PLANNED',
      'PLAN_DESCRIPTION: Plan with notify node',
      'TASK_TREE:',
      '```json',
      JSON.stringify([
        {
          id: 'step-1',
          title: 'Agent task',
          type: 'agent',
          agent: 'gmail',
          prompt: 'Check inbox',
          blockedBy: [],
        },
        {
          id: 'step-2',
          title: 'Notify user',
          type: 'notify',
          channel: 'telegram',
          message: 'Done!',
          blockedBy: ['step-1'],
        },
      ]),
      '```',
    ].join('\n');

    const result = parseTriageResponse(response);

    expect(result.mode).toBe('planned');
    expect(result.taskTree).toHaveLength(2);

    const agentNode = result.taskTree![0];
    expect(agentNode.type).toBe('agent');
    if (agentNode.type === 'agent') {
      expect(agentNode.agent).toBe('gmail');
      expect(agentNode.prompt).toBe('Check inbox');
    }

    const notifyNode = result.taskTree![1];
    expect(notifyNode.type).toBe('notify');
    if (notifyNode.type === 'notify') {
      expect(notifyNode.channel).toBe('telegram');
      expect(notifyNode.message).toBe('Done!');
    }
  });
});
