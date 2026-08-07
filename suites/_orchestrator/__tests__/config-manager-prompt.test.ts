import { describe, it, expect } from 'vitest';

// ---------- config-manager convention injection ----------
// NOTE: agents/ hasn't moved into packages/core yet (Phase 2 Task 3a moved
// services/ only) — this test stays alongside agents/config-manager.ts
// until Task 3b resolves suite agent definitions via the capability library.

describe('config-manager: convention doc injection', () => {
  it('should include convention docs in prompt when provided', async () => {
    const { buildConfigManagerPrompt } = await import('../agents/config-manager.ts');

    const prompt = buildConfigManagerPrompt({
      suites: [],
      agents: [],
      schedules: [],
      conventionDocs: {
        'Schedule Conventions': '## Schedule naming\nUse kebab-case verb-noun format.',
        'Suite Conventions': '## Required files\nsuite.ts, mcp.json, actions.json',
      },
    });

    expect(prompt).toContain('Convention Documents');
    expect(prompt).toContain('Schedule Conventions');
    expect(prompt).toContain('kebab-case verb-noun');
    expect(prompt).toContain('Suite Conventions');
    expect(prompt).toContain('Required files');
  });

  it('should not include convention section when no docs provided', async () => {
    const { buildConfigManagerPrompt } = await import('../agents/config-manager.ts');

    const prompt = buildConfigManagerPrompt({
      suites: [],
      agents: [],
      schedules: [],
    });

    expect(prompt).not.toContain('Convention Documents');
    expect(prompt).toContain('Output Format');
  });
});
