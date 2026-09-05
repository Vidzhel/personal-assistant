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
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';

const log = createLogger('library-loader');

const SKIP_DIRS = new Set(['examples']);

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function loadMcps(
  mcpsDir: string,
  diagnostics: DefinitionDiagnostic[],
): Promise<Map<string, McpDefinition>> {
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
      if (mcps.has(mcp.name)) {
        diagnostics.push({
          source: 'mcp',
          path: `mcps/${entry}`,
          code: 'duplicate-mcp-name',
          message: `Duplicate MCP name "${mcp.name}"; keeping the first definition`,
          severity: 'warning',
        });
        continue;
      }
      mcps.set(mcp.name, mcp);
    } catch (error) {
      diagnostics.push({
        source: 'mcp',
        path: `mcps/${entry}`,
        code: 'invalid-mcp-definition',
        message: `Invalid MCP definition: ${errorMessage(error)}`,
        severity: 'error',
      });
      log.warn(`Skipping invalid MCP definition: ${entry}`);
    }
  }

  return mcps;
}

async function readOptionalFile(
  filePath: string,
  libraryDir: string,
  diagnostics: DefinitionDiagnostic[],
): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      diagnostics.push({
        source: 'skill',
        path: `skills/${relativePath(libraryDir, filePath)}`,
        code: 'missing-skill-document',
        message: 'Skill has no skill.md document',
        severity: 'warning',
      });
      return '';
    }
    diagnostics.push({
      source: 'skill',
      path: `skills/${relativePath(libraryDir, filePath)}`,
      code: 'skill-document-unreadable',
      message: `Cannot read skill.md: ${errorMessage(error)}`,
      severity: 'error',
    });
    return '';
  }
}

interface SkillRegistration {
  baseDir: string;
  currentDir: string;
  config: SkillConfig;
  skillMd: string;
}

function registerSkill(
  reg: SkillRegistration,
  skills: Map<string, LoadedSkill>,
  diagnostics: DefinitionDiagnostic[],
): void {
  const relPath = relative(reg.baseDir, reg.currentDir);
  const domain = relPath.split(sep)[0] ?? '';

  if (skills.has(reg.config.name)) {
    const existing = skills.get(reg.config.name);
    diagnostics.push({
      source: 'skill',
      path: `skills/${relativePath(reg.baseDir, reg.currentDir)}/config.json`,
      code: 'duplicate-skill-name',
      message: `Duplicate skill name "${reg.config.name}" (already at ${existing?.path ?? 'unknown'})`,
      severity: 'warning',
    });
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

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

interface SkillWalkContext {
  baseDir: string;
  skills: Map<string, LoadedSkill>;
  diagnostics: DefinitionDiagnostic[];
}

async function walkSkills(currentDir: string, context: SkillWalkContext): Promise<void> {
  const { baseDir, skills, diagnostics } = context;
  const entries = await readdir(currentDir, { withFileTypes: true });
  const hasConfig = entries.some((e) => e.isFile() && e.name === 'config.json');

  if (hasConfig) {
    try {
      const raw = await readFile(join(currentDir, 'config.json'), 'utf-8');
      const config = SkillConfigSchema.parse(JSON.parse(raw) as unknown);
      const skillMd = await readOptionalFile(join(currentDir, 'skill.md'), baseDir, diagnostics);
      registerSkill({ baseDir, currentDir, config, skillMd }, skills, diagnostics);
    } catch (error) {
      diagnostics.push({
        source: 'skill',
        path: `skills/${relativePath(baseDir, join(currentDir, 'config.json'))}`,
        code: 'invalid-skill-definition',
        message: `Invalid skill definition: ${errorMessage(error)}`,
        severity: 'error',
      });
      log.warn(`Skipping invalid skill config in ${currentDir}`);
    }
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    await walkSkills(join(currentDir, entry.name), context);
  }
}

async function loadSkills(
  skillsDir: string,
  diagnostics: DefinitionDiagnostic[],
): Promise<Map<string, LoadedSkill>> {
  const skills = new Map<string, LoadedSkill>();

  if (!(await dirExists(skillsDir))) {
    return skills;
  }

  await walkSkills(skillsDir, { baseDir: skillsDir, skills, diagnostics });
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

interface LoadedLibraryWithDiagnostics extends LoadedLibrary {
  diagnostics: DefinitionDiagnostic[];
}

interface SkillReferenceContext {
  skills: Map<string, LoadedSkill>;
  mcps: Map<string, McpDefinition>;
  vendorPaths: Map<string, string>;
  diagnostics: DefinitionDiagnostic[];
}

function validateSkillReferences(context: SkillReferenceContext): void {
  const { skills, mcps, vendorPaths, diagnostics } = context;
  for (const skill of skills.values()) {
    for (const mcp of skill.config.mcps) {
      if (!mcps.has(mcp)) {
        diagnostics.push({
          source: 'skill',
          path: `skills/${skill.path}/config.json`,
          code: 'unknown-mcp-reference',
          message: `Skill "${skill.config.name}" references unknown MCP "${mcp}"`,
          severity: 'error',
        });
      }
    }
    for (const reference of skill.config.vendorSkills) {
      const vendor = reference.split('/')[0];
      if (!vendorPaths.has(vendor ?? '')) {
        diagnostics.push({
          source: 'skill',
          path: `skills/${skill.path}/config.json`,
          code: 'unknown-vendor-reference',
          message: `Skill "${skill.config.name}" references unknown vendor "${vendor ?? ''}"`,
          severity: 'error',
        });
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadLibrary(libraryDir: string): Promise<LoadedLibraryWithDiagnostics> {
  const diagnostics: DefinitionDiagnostic[] = [];
  const mcps = await loadMcps(join(libraryDir, 'mcps'), diagnostics);
  const skills = await loadSkills(join(libraryDir, 'skills'), diagnostics);
  const vendorPaths = await loadVendorPaths(join(libraryDir, 'vendor'));
  validateSkillReferences({ skills, mcps, vendorPaths, diagnostics });
  const index = buildIndex(skills, mcps);

  log.info(
    `Library loaded: ${String(skills.size)} skills, ${String(mcps.size)} mcps, ${String(vendorPaths.size)} vendors`,
  );

  return { skills, mcps, vendorPaths, index, diagnostics };
}
