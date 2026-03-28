import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

import { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { validateLibrary } from '../capability-library/library-validator.ts';

// Path to the real library/ directory
const LIBRARY_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'library');

describe('library integration', () => {
  it('loads the real library without errors', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    expect(lib.getSkillNames().length).toBeGreaterThan(0);
  });

  it('validates the real library structure', async () => {
    const errors = await validateLibrary(LIBRARY_DIR);
    expect(errors).toEqual([]);
  });

  it('resolves MCPs for ticktick skill', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const mcps = lib.collectMcpServers(['ticktick']);
    expect(mcps['ticktick']).toBeDefined();
    expect(mcps['ticktick'].command).toBe('node');
  });

  it('builds agent definitions with correct tool patterns', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const agents = lib.collectAgentDefinitions(['ticktick']);
    expect(agents['ticktick']).toBeDefined();
    expect(agents['ticktick'].tools).toContain('mcp__ticktick__*');
    expect(agents['ticktick'].prompt).toBeTruthy();
  });

  it('collects actions from gmail skill', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const actions = lib.collectActions(['gmail']);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.name.startsWith('gmail:'))).toBe(true);
  });

  it('generates a non-empty skill catalog', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const catalog = lib.getSkillCatalog();
    expect(catalog).toContain('ticktick');
    expect(catalog).toContain('Available Skills');
  });

  it('resolves vendor plugins for pdf skill', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const plugins = lib.resolveVendorPlugins(['pdf']);
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[0].type).toBe('local');
  });

  it('resolves vendor plugins for ffmpeg skill', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const plugins = lib.resolveVendorPlugins(['ffmpeg']);
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[0].type).toBe('local');
  });

  it('loads all expected skills', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const names = lib.getSkillNames();
    expect(names).toContain('ticktick');
    expect(names).toContain('gmail');
    expect(names).toContain('pdf');
    expect(names).toContain('telegram');
    expect(names).toContain('ffmpeg');
  });

  it('includes tools from skill config in agent definitions', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const agents = lib.collectAgentDefinitions(['ticktick']);
    // ticktick has tools: ["Read", "Grep"] plus MCP pattern
    expect(agents['ticktick'].tools).toContain('Read');
    expect(agents['ticktick'].tools).toContain('Grep');
  });

  it('collects actions across multiple skills', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const actions = lib.collectActions(['ticktick', 'gmail']);
    const ticktickActions = actions.filter((a) => a.name.startsWith('ticktick:'));
    const gmailActions = actions.filter((a) => a.name.startsWith('gmail:'));
    expect(ticktickActions.length).toBeGreaterThan(0);
    expect(gmailActions.length).toBeGreaterThan(0);
  });

  it('returns empty results for unknown skill names', async () => {
    const lib = new CapabilityLibrary();
    await lib.load(LIBRARY_DIR);
    const mcps = lib.collectMcpServers(['nonexistent-skill']);
    expect(Object.keys(mcps)).toHaveLength(0);
    const actions = lib.collectActions(['nonexistent-skill']);
    expect(actions).toHaveLength(0);
  });
});
