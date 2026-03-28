import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';

import { validateLibrary } from '../capability-library/library-validator.ts';

let tempDir: string;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function setup(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'lib-val-'));
  return tempDir;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function validMcp(name: string) {
  return {
    name,
    displayName: name,
    command: 'npx',
    args: ['-y', `@test/${name}`],
  };
}

function validSkillConfig(name: string, mcps: string[] = []) {
  return {
    name,
    displayName: name,
    description: `${name} skill`,
    mcps,
  };
}

function buildValidLibrary(dir: string): void {
  mkdirSync(join(dir, 'mcps'), { recursive: true });
  writeJson(join(dir, 'mcps', 'test-mcp.json'), validMcp('test-mcp'));

  const skillDir = join(dir, 'skills', 'domain', 'my-skill');
  mkdirSync(skillDir, { recursive: true });
  writeJson(join(skillDir, 'config.json'), validSkillConfig('my-skill', ['test-mcp']));
  writeFileSync(join(skillDir, 'skill.md'), '# My Skill');

  // Add _index.md for directories with subdirectories
  writeFileSync(join(dir, 'skills', '_index.md'), '# Skills');
  writeFileSync(join(dir, 'skills', 'domain', '_index.md'), '# Domain');
}

describe('validateLibrary', () => {
  it('returns no errors for a valid library', async () => {
    const dir = setup();
    buildValidLibrary(dir);

    const errors = await validateLibrary(dir);
    expect(errors).toEqual([]);
  });

  it('reports missing skill.md', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'), { recursive: true });

    const skillDir = join(dir, 'skills', 'domain', 'broken');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), validSkillConfig('broken'));

    // _index.md for parent dirs
    writeFileSync(join(dir, 'skills', '_index.md'), '# Skills');
    writeFileSync(join(dir, 'skills', 'domain', '_index.md'), '# Domain');

    const errors = await validateLibrary(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('missing skill.md');
  });

  it('reports unresolved MCP reference', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'), { recursive: true });
    writeJson(join(dir, 'mcps', 'real-mcp.json'), validMcp('real-mcp'));

    const skillDir = join(dir, 'skills', 'domain', 'bad-ref');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), validSkillConfig('bad-ref', ['nonexistent-mcp']));
    writeFileSync(join(skillDir, 'skill.md'), '# Bad Ref');

    writeFileSync(join(dir, 'skills', '_index.md'), '# Skills');
    writeFileSync(join(dir, 'skills', 'domain', '_index.md'), '# Domain');

    const errors = await validateLibrary(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('nonexistent-mcp');
    expect(errors[0]).toContain('not found');
  });

  it('reports missing _index.md for directories with subdirectories', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'), { recursive: true });

    const skillDir = join(dir, 'skills', 'domain', 'sub', 'leaf');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), validSkillConfig('leaf'));
    writeFileSync(join(skillDir, 'skill.md'), '# Leaf');

    // Deliberately omit _index.md for skills/, skills/domain/, and skills/domain/sub/
    const errors = await validateLibrary(dir);
    const indexErrors = errors.filter((e) => e.includes('_index.md'));
    expect(indexErrors.length).toBeGreaterThanOrEqual(3);
  });

  it('reports invalid config.json schema', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'), { recursive: true });

    const skillDir = join(dir, 'skills', 'domain', 'bad-config');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), { invalid: true });
    writeFileSync(join(skillDir, 'skill.md'), '# Bad Config');

    writeFileSync(join(dir, 'skills', '_index.md'), '# Skills');
    writeFileSync(join(dir, 'skills', 'domain', '_index.md'), '# Domain');

    const errors = await validateLibrary(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid schema');
  });

  it('reports invalid MCP definition', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'), { recursive: true });
    writeJson(join(dir, 'mcps', 'bad.json'), { not: 'valid' });

    const errors = await validateLibrary(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('invalid MCP definition');
  });
});
