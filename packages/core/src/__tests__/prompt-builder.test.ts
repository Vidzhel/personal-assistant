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

  it('includes knowledge context section when knowledgeContext is provided', () => {
    const prompt = buildSystemPrompt(makeTask(), undefined, 'Some knowledge content');
    expect(prompt).toContain('## Relevant Knowledge');
    expect(prompt).toContain('Some knowledge content');
  });

  it('does not include knowledge section when knowledgeContext is undefined', () => {
    const prompt = buildSystemPrompt(makeTask());
    expect(prompt).not.toContain('Relevant Knowledge');
  });

  it('does not include knowledge section when knowledgeContext is empty string', () => {
    const prompt = buildSystemPrompt(makeTask(), undefined, '');
    expect(prompt).not.toContain('Relevant Knowledge');
  });

  it('places knowledge section before project context section', () => {
    const project: Project = {
      id: 'p1',
      name: 'Test',
      skills: [],
      systemPrompt: 'Project info',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = buildSystemPrompt(makeTask(), project, 'Knowledge info');
    const knowledgeIdx = prompt.indexOf('## Relevant Knowledge');
    const projectIdx = prompt.indexOf('## Project Context');
    expect(knowledgeIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeGreaterThan(-1);
    expect(knowledgeIdx).toBeLessThan(projectIdx);
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
