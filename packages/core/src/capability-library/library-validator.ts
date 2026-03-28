import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { McpDefinitionSchema, SkillConfigSchema } from '@raven/shared';

interface ValidationContext {
  baseDir: string;
  mcpNames: Set<string>;
  errors: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function validateMcps(mcpsDir: string, errors: string[]): Promise<void> {
  if (!(await isDirectory(mcpsDir))) return;

  const entries = await readdir(mcpsDir);

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(mcpsDir, entry);
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      McpDefinitionSchema.parse(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`mcps/${entry}: invalid MCP definition — ${msg}`);
    }
  }
}

async function validateSkillConfig(
  relPath: string,
  currentDir: string,
  ctx: ValidationContext,
): Promise<void> {
  try {
    const raw = await readFile(join(currentDir, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const config = SkillConfigSchema.parse(parsed);

    for (const mcpRef of config.mcps) {
      if (!ctx.mcpNames.has(mcpRef)) {
        ctx.errors.push(`skills/${relPath}: MCP reference "${mcpRef}" not found in library/mcps/`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.errors.push(`skills/${relPath}/config.json: invalid schema — ${msg}`);
  }

  if (!(await exists(join(currentDir, 'skill.md')))) {
    ctx.errors.push(`skills/${relPath}: missing skill.md`);
  }
}

async function validateSkillDir(currentDir: string, ctx: ValidationContext): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const hasConfig = entries.some((e) => e.isFile() && e.name === 'config.json');
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  if (hasConfig) {
    const relPath = currentDir.slice(ctx.baseDir.length + 1);
    await validateSkillConfig(relPath, currentDir, ctx);
    return;
  }

  if (subdirs.length > 0 && !(await exists(join(currentDir, '_index.md')))) {
    const relPath = currentDir.slice(ctx.baseDir.length + 1) || '.';
    ctx.errors.push(`skills/${relPath}: missing _index.md (directory has subdirectories)`);
  }

  for (const entry of subdirs) {
    await validateSkillDir(join(currentDir, entry.name), ctx);
  }
}

async function collectMcpNames(mcpsDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  if (!(await isDirectory(mcpsDir))) return names;

  const entries = await readdir(mcpsDir);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(mcpsDir, entry), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const mcp = McpDefinitionSchema.parse(parsed);
      names.add(mcp.name);
    } catch {
      // Already reported by validateMcps
    }
  }
  return names;
}

export async function validateLibrary(libraryDir: string): Promise<string[]> {
  const errors: string[] = [];

  const mcpsDir = join(libraryDir, 'mcps');
  const skillsDir = join(libraryDir, 'skills');

  await validateMcps(mcpsDir, errors);

  const mcpNames = await collectMcpNames(mcpsDir);

  if (await isDirectory(skillsDir)) {
    await validateSkillDir(skillsDir, { baseDir: skillsDir, mcpNames, errors });
  }

  return errors;
}
