import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';

import { loadLibrary } from '../capability-library/library-loader.ts';

let tempDir: string;

function setup(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'lib-loader-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function validMcp(name: string) {
  return { name, displayName: name, command: 'npx', args: ['-y', `@test/${name}`] };
}

function validSkillConfig(name: string) {
  return { name, displayName: name, description: `${name} skill` };
}

describe('loadLibrary', () => {
  it('loads MCP definitions from mcps/ directory', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'));
    writeJson(join(dir, 'mcps', 'ticktick.json'), validMcp('ticktick'));
    writeJson(join(dir, 'mcps', 'gmail.json'), validMcp('gmail'));

    const lib = await loadLibrary(dir);

    expect(lib.mcps.size).toBe(2);
    expect(lib.mcps.get('ticktick')?.command).toBe('npx');
    expect(lib.mcps.get('gmail')?.name).toBe('gmail');
  });

  it('loads skill configs from nested directories', async () => {
    const dir = setup();
    const skillDir = join(dir, 'skills', 'productivity', 'task-management', 'ticktick');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), validSkillConfig('ticktick'));
    writeFileSync(join(skillDir, 'skill.md'), '# TickTick Skill\nManage tasks.');

    const lib = await loadLibrary(dir);

    expect(lib.skills.size).toBe(1);
    const skill = lib.skills.get('ticktick');
    expect(skill).toBeDefined();
    expect(skill!.config.name).toBe('ticktick');
    expect(skill!.skillMd).toBe('# TickTick Skill\nManage tasks.');
  });

  it('computes domain and path correctly', async () => {
    const dir = setup();
    const skillDir = join(dir, 'skills', 'communication', 'email', 'gmail');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), validSkillConfig('gmail'));

    const lib = await loadLibrary(dir);
    const skill = lib.skills.get('gmail');

    expect(skill!.domain).toBe('communication');
    expect(skill!.path).toBe(join('communication', 'email', 'gmail'));
  });

  it('skips invalid MCP configs', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'));
    writeJson(join(dir, 'mcps', 'good.json'), validMcp('good'));
    writeJson(join(dir, 'mcps', 'bad.json'), { name: 'BadName' }); // invalid: no command, bad casing

    const lib = await loadLibrary(dir);

    expect(lib.mcps.size).toBe(1);
    expect(lib.mcps.has('good')).toBe(true);
  });

  it('skips invalid skill configs', async () => {
    const dir = setup();
    const goodDir = join(dir, 'skills', 'domain', 'good-skill');
    const badDir = join(dir, 'skills', 'domain', 'bad-skill');
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(badDir, { recursive: true });
    writeJson(join(goodDir, 'config.json'), validSkillConfig('good-skill'));
    writeJson(join(badDir, 'config.json'), { name: 'BadName' }); // invalid: bad casing, missing fields

    const lib = await loadLibrary(dir);

    expect(lib.skills.size).toBe(1);
    expect(lib.skills.has('good-skill')).toBe(true);
  });

  it('resolves vendor paths', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'vendor', 'claude-code'), { recursive: true });
    mkdirSync(join(dir, 'vendor', 'some-tool'), { recursive: true });

    const lib = await loadLibrary(dir);

    expect(lib.vendorPaths.size).toBe(2);
    expect(lib.vendorPaths.get('claude-code')).toBe(join(dir, 'vendor', 'claude-code'));
    expect(lib.vendorPaths.get('some-tool')).toBe(join(dir, 'vendor', 'some-tool'));
  });

  it('builds complete library index', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'));
    writeJson(join(dir, 'mcps', 'ticktick.json'), validMcp('ticktick'));

    const skillDir = join(dir, 'skills', 'productivity', 'tasks');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), validSkillConfig('tasks'));

    const lib = await loadLibrary(dir);

    expect(lib.index.skills).toEqual([
      { name: 'tasks', path: join('productivity', 'tasks'), description: 'tasks skill' },
    ]);
    expect(lib.index.mcps).toEqual([{ name: 'ticktick', path: 'mcps/ticktick.json' }]);
  });

  it('detects duplicate skill names and keeps first', async () => {
    const dir = setup();
    // Create two skills with the same config name in different paths
    const dir1 = join(dir, 'skills', 'domain-a', 'my-skill');
    const dir2 = join(dir, 'skills', 'domain-b', 'my-skill');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeJson(join(dir1, 'config.json'), validSkillConfig('my-skill'));
    writeJson(join(dir2, 'config.json'), validSkillConfig('my-skill'));

    const lib = await loadLibrary(dir);

    expect(lib.skills.size).toBe(1);
    // Should keep the first one found (domain-a comes before domain-b alphabetically)
    expect(lib.skills.get('my-skill')!.domain).toBe('domain-a');
  });

  it('handles missing directories gracefully', async () => {
    const dir = setup();
    // Empty dir - no mcps/, skills/, or vendor/

    const lib = await loadLibrary(dir);

    expect(lib.mcps.size).toBe(0);
    expect(lib.skills.size).toBe(0);
    expect(lib.vendorPaths.size).toBe(0);
    expect(lib.index.skills).toEqual([]);
    expect(lib.index.mcps).toEqual([]);
  });

  it('skips directories named examples or starting with dot', async () => {
    const dir = setup();
    const examplesDir = join(dir, 'skills', 'examples', 'demo');
    const hiddenDir = join(dir, 'skills', '.hidden', 'secret');
    const validDir = join(dir, 'skills', 'real', 'skill');
    mkdirSync(examplesDir, { recursive: true });
    mkdirSync(hiddenDir, { recursive: true });
    mkdirSync(validDir, { recursive: true });
    writeJson(join(examplesDir, 'config.json'), validSkillConfig('example-skill'));
    writeJson(join(hiddenDir, 'config.json'), validSkillConfig('hidden-skill'));
    writeJson(join(validDir, 'config.json'), validSkillConfig('real-skill'));

    const lib = await loadLibrary(dir);

    expect(lib.skills.size).toBe(1);
    expect(lib.skills.has('real-skill')).toBe(true);
  });

  it('handles skill without skill.md', async () => {
    const dir = setup();
    const skillDir = join(dir, 'skills', 'domain', 'bare-skill');
    mkdirSync(skillDir, { recursive: true });
    writeJson(join(skillDir, 'config.json'), validSkillConfig('bare-skill'));

    const lib = await loadLibrary(dir);
    const skill = lib.skills.get('bare-skill');

    expect(skill!.skillMd).toBe('');
  });

  it('ignores non-json files in mcps directory', async () => {
    const dir = setup();
    mkdirSync(join(dir, 'mcps'));
    writeJson(join(dir, 'mcps', 'valid.json'), validMcp('valid'));
    writeFileSync(join(dir, 'mcps', 'README.md'), '# MCPs');

    const lib = await loadLibrary(dir);

    expect(lib.mcps.size).toBe(1);
  });
});
