import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTemplatesFromDir } from '../template-engine/template-loader.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function validTemplateYaml(name: string): string {
  return `
name: ${name}
displayName: "${name} template"
tasks:
  - type: agent
    id: step-1
    title: Do something
    prompt: "Execute the task"
`;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('loadTemplatesFromDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-tmpl-v2-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid template from YAML', async () => {
    writeFileSync(join(tmpDir, 'digest.yaml'), validTemplateYaml('daily-digest'));

    const result = await loadTemplatesFromDir(tmpDir);

    expect(result.size).toBe(1);
    const tmpl = result.get('daily-digest');
    expect(tmpl).toBeDefined();
    expect(tmpl!.displayName).toBe('daily-digest template');
    expect(tmpl!.tasks).toHaveLength(1);
    // Verify defaults applied
    expect(tmpl!.plan.approval).toBe('manual');
    expect(tmpl!.trigger).toEqual([{ type: 'manual' }]);
  });

  it('skips invalid YAML files with warning', async () => {
    writeFileSync(join(tmpDir, 'good.yaml'), validTemplateYaml('good-one'));
    writeFileSync(join(tmpDir, 'bad.yaml'), 'name: BAD NAME WITH SPACES\ntasks: []\n');

    const result = await loadTemplatesFromDir(tmpDir);

    expect(result.size).toBe(1);
    expect(result.has('good-one')).toBe(true);
  });

  it('returns empty map for non-existent directory', async () => {
    const result = await loadTemplatesFromDir('/tmp/does-not-exist-ever-12345');

    expect(result.size).toBe(0);
  });

  it('loads multiple templates correctly', async () => {
    writeFileSync(join(tmpDir, 'a.yaml'), validTemplateYaml('alpha'));
    writeFileSync(join(tmpDir, 'b.yml'), validTemplateYaml('beta'));
    writeFileSync(join(tmpDir, 'c.yaml'), validTemplateYaml('gamma'));

    const result = await loadTemplatesFromDir(tmpDir);

    expect(result.size).toBe(3);
    expect(result.has('alpha')).toBe(true);
    expect(result.has('beta')).toBe(true);
    expect(result.has('gamma')).toBe(true);
  });

  it('duplicate template names: last wins', async () => {
    // Files are read in readdir order (alphabetical on most systems)
    writeFileSync(
      join(tmpDir, 'a-first.yaml'),
      `
name: same-name
displayName: "First"
tasks:
  - type: agent
    id: s1
    title: First task
    prompt: "First"
`,
    );
    writeFileSync(
      join(tmpDir, 'b-second.yaml'),
      `
name: same-name
displayName: "Second"
tasks:
  - type: agent
    id: s1
    title: Second task
    prompt: "Second"
`,
    );

    const result = await loadTemplatesFromDir(tmpDir);

    expect(result.size).toBe(1);
    const tmpl = result.get('same-name');
    expect(tmpl).toBeDefined();
    // b-second.yaml comes after a-first.yaml alphabetically, so it wins
    expect(tmpl!.displayName).toBe('Second');
  });

  it('ignores non-YAML files', async () => {
    writeFileSync(join(tmpDir, 'readme.md'), '# Not a template');
    writeFileSync(join(tmpDir, 'data.json'), '{}');
    writeFileSync(join(tmpDir, 'actual.yaml'), validTemplateYaml('real-one'));

    const result = await loadTemplatesFromDir(tmpDir);

    expect(result.size).toBe(1);
    expect(result.has('real-one')).toBe(true);
  });
});
