import { readFile, writeFile, readdir, stat, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';

import yaml from 'js-yaml';
const { load: yamlLoad } = yaml;

import { createLogger } from '@raven/shared';

const log = createLogger('memory-store');

const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_TOTAL_KB = 64;
const BYTES_PER_KB = 1024;
const INDEX_FILE = 'MEMORY.md';

export interface MemoryUsage {
  files: number;
  totalBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export interface MemoryWriteResult {
  ok: boolean;
  error?: string;
  usage?: MemoryUsage;
}

export interface MemoryStore {
  read(agentName: string, relPath: string): Promise<string>;
  readIndex(agentName: string): Promise<string | null>;
  write(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult>;
  update(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult>;
  /** Deletes a memory file (used by consolidation to prune superseded
   * facts). `ok: false` with no throw when the file doesn't exist. */
  remove(agentName: string, relPath: string): Promise<MemoryWriteResult>;
  /** Filenames present in the agent's memory dir (flat — no subdirs, e.g.
   * `candidates/`, are ever returned since listMemoryFiles only lists
   * files). Includes MEMORY.md; callers that want just the fact files
   * filter it out themselves. */
  list(agentName: string): Promise<string[]>;
  usage(agentName: string): Promise<MemoryUsage>;
}

interface Budget {
  maxFiles: number;
  maxTotalBytes: number;
}

interface WriteOpts {
  agentName: string;
  relPath: string;
  content: string;
  mustExist: boolean;
  projectsDir: string;
}

/** Wrap a MEMORY.md index for injection into an agent's system prompt. */
export function formatMemoryBlock(index: string): string {
  return [
    '## Your Memory',
    'This is the index of what you remember from past work. Use the `memory_read` tool to',
    'read a specific file, `memory_write` to save a new note, and `memory_update` to revise',
    'an existing one. Keep entries concise — your memory has a hard budget.',
    '',
    index.trim(),
  ].join('\n');
}

/** Exported so sibling modules (memory-candidates.ts, memory-consolidation.ts)
 * can validate an agent name without duplicating this check. */
export function validateAgentName(agentName: string): void {
  if (agentName.includes('/') || agentName.includes('\\') || agentName === '..') {
    throw new Error(`invalid agentName: ${agentName}`);
  }
}

/** Exported so sibling modules can resolve an agent's memory dir (e.g. to
 * derive `memory/candidates/`) without duplicating this join. */
export function resolveMemoryDir(projectsDir: string, agentName: string): string {
  return join(projectsDir, 'agents', agentName, 'memory');
}

function resolveAgentYamlPath(projectsDir: string, agentName: string): string {
  const dirLayout = join(projectsDir, 'agents', agentName, 'agent.yaml');
  if (existsSync(dirLayout)) return dirLayout;
  return join(projectsDir, 'agents', `${agentName}.yaml`);
}

async function readBudget(projectsDir: string, agentName: string): Promise<Budget> {
  try {
    const raw = yamlLoad(await readFile(resolveAgentYamlPath(projectsDir, agentName), 'utf-8')) as {
      memory?: { maxFiles?: number; maxTotalKb?: number };
    };
    return {
      maxFiles: raw?.memory?.maxFiles ?? DEFAULT_MAX_FILES,
      maxTotalBytes: (raw?.memory?.maxTotalKb ?? DEFAULT_MAX_TOTAL_KB) * BYTES_PER_KB,
    };
  } catch {
    return { maxFiles: DEFAULT_MAX_FILES, maxTotalBytes: DEFAULT_MAX_TOTAL_KB * BYTES_PER_KB };
  }
}

/** Resolve a relative path strictly inside the agent's memory dir, or throw. */
function safePath(projectsDir: string, agentName: string, relPath: string): string {
  const dir = resolveMemoryDir(projectsDir, agentName);
  const resolved = resolve(dir, relPath);
  const rel = relative(dir, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`invalid path: ${relPath}`);
  }
  if (rel.includes('/') || rel.includes('\\')) {
    throw new Error(`invalid path: nested paths are not allowed: ${relPath}`);
  }
  return resolved;
}

async function listMemoryFiles(
  projectsDir: string,
  agentName: string,
): Promise<Array<{ name: string; size: number }>> {
  const dir = resolveMemoryDir(projectsDir, agentName);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ name: string; size: number }> = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const s = await stat(join(dir, entry.name));
      files.push({ name: entry.name, size: s.size });
    }
  }
  return files;
}

async function computeUsage(
  projectsDir: string,
  agentName: string,
  budget: Budget,
): Promise<MemoryUsage> {
  const files = await listMemoryFiles(projectsDir, agentName);
  return {
    files: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    maxFiles: budget.maxFiles,
    maxTotalBytes: budget.maxTotalBytes,
  };
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, absPath);
}

interface BudgetCheckInput {
  projectsDir: string;
  agentName: string;
  absPath: string;
  content: string;
  fileExists: boolean;
}

/** Isolated from checkAndWrite so that function's own complexity stays
 * under the guardrail threshold — this holds the two budget-limit branches,
 * checkAndWrite holds the existence/directory branches. Returns null when
 * the write is within budget. */
async function checkBudgetLimits(input: BudgetCheckInput): Promise<MemoryWriteResult | null> {
  const { projectsDir, agentName, absPath, content, fileExists } = input;
  const budget = await readBudget(projectsDir, agentName);
  const files = await listMemoryFiles(projectsDir, agentName);
  const dir = resolveMemoryDir(projectsDir, agentName);
  const existingSize = files.find((f) => join(dir, f.name) === absPath)?.size ?? 0;
  const newBytes = Buffer.byteLength(content, 'utf-8');

  const projectedFiles = fileExists ? files.length : files.length + 1;
  const projectedBytes = files.reduce((s, f) => s + f.size, 0) - existingSize + newBytes;
  const usage = await computeUsage(projectsDir, agentName, budget);

  if (projectedFiles > budget.maxFiles) {
    return {
      ok: false,
      error: `memory budget exceeded: ${projectedFiles} files > ${budget.maxFiles} max. Consolidate or prune first.`,
      usage,
    };
  }
  if (projectedBytes > budget.maxTotalBytes) {
    return {
      ok: false,
      error: `memory budget exceeded: ${projectedBytes} bytes > ${budget.maxTotalBytes} max. Consolidate or prune first.`,
      usage,
    };
  }
  return null;
}

async function checkAndWrite(opts: WriteOpts): Promise<MemoryWriteResult> {
  const { agentName, relPath, content, mustExist, projectsDir } = opts;
  const absPath = safePath(projectsDir, agentName, relPath);
  const fileExists = existsSync(absPath);
  // A single path segment like "candidates" passes safePath (no slashes)
  // but can resolve to a real subdirectory (memory-candidates.ts creates
  // memory/<agent>/candidates/) — writing/renaming a file over that throws
  // a noisy EISDIR further down in atomicWrite. Reject it here with a clear
  // error instead.
  if (fileExists && (await stat(absPath)).isDirectory()) {
    return { ok: false, error: `memory path is a directory, not a file: ${relPath}` };
  }
  if (mustExist && !fileExists) {
    return { ok: false, error: `memory file does not exist: ${relPath}` };
  }

  const budgetError = await checkBudgetLimits({
    projectsDir,
    agentName,
    absPath,
    content,
    fileExists,
  });
  if (budgetError) return budgetError;

  await atomicWrite(absPath, content);
  log.info(`memory ${mustExist ? 'updated' : 'written'}: ${agentName}/${relPath}`);
  const budget = await readBudget(projectsDir, agentName);
  return { ok: true, usage: await computeUsage(projectsDir, agentName, budget) };
}

/** Standalone (not a createMemoryStore closure member) so remove()'s body
 * doesn't push createMemoryStore over the max-lines-per-function guardrail
 * — mirrors checkAndWrite's relationship to write()/update(). */
async function removeMemoryFile(
  projectsDir: string,
  agentName: string,
  relPath: string,
): Promise<MemoryWriteResult> {
  const absPath = safePath(projectsDir, agentName, relPath);
  if (!existsSync(absPath)) {
    return { ok: false, error: `memory file does not exist: ${relPath}` };
  }
  if ((await stat(absPath)).isDirectory()) {
    return { ok: false, error: `memory path is a directory, not a file: ${relPath}` };
  }
  try {
    await unlink(absPath);
    log.info(`memory removed: ${agentName}/${relPath}`);
  } catch (err) {
    return { ok: false, error: `failed to remove memory file: ${(err as Error).message}` };
  }
  const budget = await readBudget(projectsDir, agentName);
  return { ok: true, usage: await computeUsage(projectsDir, agentName, budget) };
}

export function createMemoryStore(deps: { projectsDir: string }): MemoryStore {
  const { projectsDir } = deps;

  return {
    async read(agentName: string, relPath: string): Promise<string> {
      validateAgentName(agentName);
      const absPath = safePath(projectsDir, agentName, relPath);
      return readFile(absPath, 'utf-8');
    },

    async readIndex(agentName: string): Promise<string | null> {
      validateAgentName(agentName);
      try {
        return await readFile(join(resolveMemoryDir(projectsDir, agentName), INDEX_FILE), 'utf-8');
      } catch {
        return null;
      }
    },

    async write(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult> {
      validateAgentName(agentName);
      return checkAndWrite({ agentName, relPath, content, mustExist: false, projectsDir });
    },

    async update(agentName: string, relPath: string, content: string): Promise<MemoryWriteResult> {
      validateAgentName(agentName);
      return checkAndWrite({ agentName, relPath, content, mustExist: true, projectsDir });
    },

    async remove(agentName: string, relPath: string): Promise<MemoryWriteResult> {
      validateAgentName(agentName);
      return removeMemoryFile(projectsDir, agentName, relPath);
    },

    async list(agentName: string): Promise<string[]> {
      validateAgentName(agentName);
      const files = await listMemoryFiles(projectsDir, agentName);
      return files.map((f) => f.name);
    },

    async usage(agentName: string): Promise<MemoryUsage> {
      validateAgentName(agentName);
      return computeUsage(projectsDir, agentName, await readBudget(projectsDir, agentName));
    },
  };
}
