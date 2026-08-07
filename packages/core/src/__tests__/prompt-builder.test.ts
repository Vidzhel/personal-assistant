import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildSubAgentPrompt } from '../agent-manager/prompt-builder.ts';
import type { AgentTask, Project } from '@raven/shared';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    skillName: 'orchestrator',
    prompt: 'test prompt',
    status: 'queued',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('includes base instructions', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('Raven');
    expect(prompt).toContain('personal assistant');
    expect(prompt).toContain('Guidelines');
    expect(prompt).toContain('concise');
  });

  it('includes project-specific system prompt when provided', () => {
    const project: Project = {
      id: 'p1',
      name: 'Test',
      skills: [],
      systemPrompt: 'Custom project instructions here.',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = buildSystemPrompt(makeTask(), project);
    expect(prompt).toContain('Project Context');
    expect(prompt).toContain('Custom project instructions here.');
  });

  it('does not include project section when no project', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).not.toContain('Project Context');
  });

  it('does not include project section when project has no systemPrompt', () => {
    const project: Project = {
      id: 'p1',
      name: 'Test',
      skills: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = buildSystemPrompt(makeTask(), project);
    expect(prompt).not.toContain('Project Context');
  });

  it('does not include knowledge section (agents use MCP get_knowledge_context instead)', () => {
    const prompt = buildSystemPrompt(makeTask({ knowledgeContext: 'Some knowledge content' }));
    expect(prompt).not.toContain('## Relevant Knowledge');
  });

  it('includes task board context when set', () => {
    const prompt = buildSystemPrompt(
      makeTask({ taskBoardContext: 'You are working task-1 under parent root.' }),
    );
    expect(prompt).toContain('## Task Board');
    expect(prompt).toContain('You are working task-1 under parent root.');
  });

  it('does not include task board section when unset', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).not.toContain('## Task Board');
  });

  // Stable prompt layers relocated from orchestrator.ts's per-turn user-
  // message prepends (see orchestrator.test.ts for the orchestrator-side
  // assertions on the fields that feed these). Moved here so SDK session
  // resume doesn't re-teach the same rules every turn.
  it('includes MCP tool instructions for orchestrator tasks', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('Raven MCP tools');
    expect(prompt).toContain('classify_request');
    expect(prompt).toContain('create_task_tree');
  });

  it('includes tool use instructions for orchestrator tasks', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).toContain('Use tools purposefully');
  });

  it('includes system access instructions when set', () => {
    const prompt = buildSystemPrompt(
      makeTask({ systemAccessInstructions: 'You MUST NOT read or modify any system files' }),
    );
    expect(prompt).toContain('## System Access Control');
    expect(prompt).toContain('You MUST NOT read or modify any system files');
  });

  it('does not include system access section when unset', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).not.toContain('## System Access Control');
  });

  it('includes named agent instructions when set', () => {
    const prompt = buildSystemPrompt(
      makeTask({ namedAgentInstructions: 'Always respond in French' }),
    );
    expect(prompt).toContain('## Agent Instructions');
    expect(prompt).toContain('Always respond in French');
  });

  it('does not include agent instructions section when unset', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).not.toContain('## Agent Instructions');
  });

  it('omits stable prompt layers for non-orchestrator skills', () => {
    const prompt = buildSystemPrompt(
      makeTask({
        skillName: 'gmail',
        systemAccessInstructions: 'You MUST NOT read or modify any system files',
        namedAgentInstructions: 'Always respond in French',
      }),
    );
    expect(prompt).not.toContain('Raven MCP tools');
    expect(prompt).not.toContain('## System Access Control');
    expect(prompt).not.toContain('## Agent Instructions');
  });
});

describe('buildSubAgentPrompt', () => {
  it('includes skill name', () => {
    const prompt = buildSubAgentPrompt('gmail', 'Read my emails');
    expect(prompt).toContain('gmail');
  });

  it('includes task prompt', () => {
    const prompt = buildSubAgentPrompt('ticktick', 'List all tasks');
    expect(prompt).toContain('List all tasks');
  });

  it('includes agent role description', () => {
    const prompt = buildSubAgentPrompt('digest', 'Generate digest');
    expect(prompt).toContain('specialized');
    expect(prompt).toContain('Raven');
  });
});
