import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { createLogger, McpDefinitionSchema, SkillConfigSchema } from '@raven/shared';
import type {
  McpDefinition,
  SkillConfig,
  LoadedSkill,
  LoadedLibrary,
  LibraryIndex,
} from '@raven/shared';

const log = createLogger('library-loader');

const SKIP_DIRS = new Set(['examples']);

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function loadMcps(mcpsDir: string): Promise<Map<string, McpDefinition>> {
  const mcps = new Map<string, McpDefinition>();

  if (!(await dirExists(mcpsDir))) {
    return mcps;
  }

  const entries = await readdir(mcpsDir);

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;

    const filePath = join(mcpsDir, entry);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const mcp = McpDefinitionSchema.parse(parsed);
      mcps.set(mcp.name, mcp);
    } catch {
      log.warn(`Skipping invalid MCP definition: ${entry}`);
    }
  }

  return mcps;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

interface SkillRegistration {
  baseDir: string;
  currentDir: string;
  config: SkillConfig;
  skillMd: string;
}

function registerSkill(reg: SkillRegistration, skills: Map<string, LoadedSkill>): void {
  const relPath = relative(reg.baseDir, reg.currentDir);
  const domain = relPath.split(sep)[0] ?? '';

  if (skills.has(reg.config.name)) {
    const existing = skills.get(reg.config.name);
    log.warn(
      `Duplicate skill name "${reg.config.name}" at ${relPath} (already at ${existing?.path ?? 'unknown'}), keeping first`,
    );
    return;
  }

  skills.set(reg.config.name, {
    config: reg.config,
    skillMd: reg.skillMd,
    path: relPath,
    domain,
  });
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

async function walkSkills(
  baseDir: string,
  currentDir: string,
  skills: Map<string, LoadedSkill>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const hasConfig = entries.some((e) => e.isFile() && e.name === 'config.json');

  if (hasConfig) {
    try {
      const raw = await readFile(join(currentDir, 'config.json'), 'utf-8');
      const config = SkillConfigSchema.parse(JSON.parse(raw) as unknown);
      const skillMd = await readOptionalFile(join(currentDir, 'skill.md'));
      registerSkill({ baseDir, currentDir, config, skillMd }, skills);
    } catch {
      log.warn(`Skipping invalid skill config in ${currentDir}`);
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    await walkSkills(baseDir, join(currentDir, entry.name), skills);
  }
}

async function loadSkills(skillsDir: string): Promise<Map<string, LoadedSkill>> {
  const skills = new Map<string, LoadedSkill>();

  if (!(await dirExists(skillsDir))) {
    return skills;
  }

  await walkSkills(skillsDir, skillsDir, skills);
  return skills;
}

async function loadVendorPaths(vendorDir: string): Promise<Map<string, string>> {
  const vendors = new Map<string, string>();

  if (!(await dirExists(vendorDir))) {
    return vendors;
  }

  const entries = await readdir(vendorDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    vendors.set(entry.name, join(vendorDir, entry.name));
  }

  return vendors;
}

function buildIndex(
  skills: Map<string, LoadedSkill>,
  mcps: Map<string, McpDefinition>,
): LibraryIndex {
  const skillEntries = Array.from(skills.entries()).map(([name, skill]) => ({
    name,
    path: skill.path,
    description: skill.config.description,
  }));

  const mcpEntries = Array.from(mcps.entries()).map(([name]) => ({
    name,
    path: `mcps/${name}.json`,
  }));

  return { skills: skillEntries, mcps: mcpEntries };
}

export async function loadLibrary(libraryDir: string): Promise<LoadedLibrary> {
  const mcps = await loadMcps(join(libraryDir, 'mcps'));
  const skills = await loadSkills(join(libraryDir, 'skills'));
  const vendorPaths = await loadVendorPaths(join(libraryDir, 'vendor'));
  const index = buildIndex(skills, mcps);

  log.info(
    `Library loaded: ${String(skills.size)} skills, ${String(mcps.size)} mcps, ${String(vendorPaths.size)} vendors`,
  );

  return { skills, mcps, vendorPaths, index };
}
