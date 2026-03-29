import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Resolve the core src directory
const CORE_SRC = resolve(import.meta.dirname, '../..');

describe('MCP migration regression', () => {
  it('plan-builder.ts is deleted', () => {
    const exists = existsSync(join(CORE_SRC, 'task-execution/plan-builder.ts'));
    expect(exists).toBe(false);
  });

  it('no file imports plan-builder', () => {
    // Use a simple approach: read key files that might have imported it
    const filesToCheck = ['orchestrator/orchestrator.ts', 'index.ts'];
    for (const file of filesToCheck) {
      const fullPath = join(CORE_SRC, file);
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, 'utf8');
      expect(content).not.toContain('plan-builder');
    }
  });

  it('no prompt contains EXECUTION_MODE marker instructions', () => {
    const filesToCheck = ['orchestrator/orchestrator.ts', 'agent-manager/prompt-builder.ts'];
    for (const file of filesToCheck) {
      const fullPath = join(CORE_SRC, file);
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, 'utf8');
      expect(content).not.toContain('EXECUTION_MODE:');
    }
  });

  it('knowledge agent does not contain localhost REST API specs', () => {
    const fullPath = join(CORE_SRC, 'knowledge-engine/knowledge-agent.ts');
    if (!existsSync(fullPath)) return;
    const content = readFileSync(fullPath, 'utf8');
    expect(content).not.toContain('http://localhost');
    expect(content).not.toContain('/api/knowledge');
  });

  it('no validation prompt contains SCORE: N pattern', () => {
    const fullPath = join(CORE_SRC, 'task-execution/create-validation-deps.ts');
    if (!existsSync(fullPath)) return;
    const content = readFileSync(fullPath, 'utf8');
    expect(content).not.toMatch(/Respond with SCORE/);
  });

  it('orchestrator does not inject meta-project REST API specs', () => {
    const fullPath = join(CORE_SRC, 'orchestrator/orchestrator.ts');
    if (!existsSync(fullPath)) return;
    const content = readFileSync(fullPath, 'utf8');
    expect(content).not.toContain('GET/POST http://localhost');
    expect(content).not.toContain('/api/agents (GET, POST, PATCH, DELETE)');
  });

  it('prompt-builder does not inject knowledge or skill catalog context', () => {
    const fullPath = join(CORE_SRC, 'agent-manager/prompt-builder.ts');
    if (!existsSync(fullPath)) return;
    const content = readFileSync(fullPath, 'utf8');
    expect(content).not.toContain('task.knowledgeContext');
    expect(content).not.toContain('task.skillCatalogContext');
  });
});
