/**
 * Interactive suite testing helper.
 *
 * Usage:
 *   npx tsx scripts/test-suite.ts <suite-name> [claude-args...]
 *   npx tsx scripts/test-suite.ts task-management -p "List my tasks"
 *   npx tsx scripts/test-suite.ts _orchestrator
 *   npx tsx scripts/test-suite.ts --list
 *
 * Resolves a suite's TS agent definitions and MCP configs,
 * then launches `claude` with the appropriate --agents and --mcp-config flags.
 */

import { readdir, readFile, stat, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveEnvVars, parseMcpConfig } from '@raven/shared';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const SUITES_DIR = join(PROJECT_ROOT, 'suites');

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: npx tsx scripts/test-suite.ts <suite-name> [claude-args...]');
    console.log('       npx tsx scripts/test-suite.ts --list');
    console.log('       npx tsx scripts/test-suite.ts task-management -p "List my tasks"');
    process.exit(0);
  }

  if (args[0] === '--list') {
    const entries = await readdir(SUITES_DIR);
    console.log('Available suites:');
    for (const entry of entries.sort()) {
      const s = await stat(join(SUITES_DIR, entry));
      if (s.isDirectory()) console.log(`  ${entry}`);
    }
    process.exit(0);
  }

  const suiteName = args[0];
  const claudeArgs = args.slice(1);
  const suiteDir = join(SUITES_DIR, suiteName);

  if (!(await exists(suiteDir))) {
    console.error(`Suite not found: ${suiteName}`);
    console.error(`Available: ${(await readdir(SUITES_DIR)).join(', ')}`);
    process.exit(1);
  }

  // Load agents from suite (and _orchestrator if loading a non-orchestrator suite)
  const agents: Record<string, { description: string; prompt: string; tools?: string[]; model?: string; mcpServers?: string[] }> = {};
  const suitesToLoad = suiteName === '_orchestrator'
    ? await getAllEnabledSuites()
    : [suiteName];

  for (const name of suitesToLoad) {
    const dir = join(SUITES_DIR, name);
    const agentsDir = join(dir, 'agents');
    if (await exists(agentsDir)) {
      const files = await readdir(agentsDir);
      for (const file of files.filter(f => f.endsWith('.ts'))) {
        const mod = await import(join(agentsDir, file));
        const agent = mod.default as { name: string; description: string; prompt: string; tools?: string[]; model?: string; mcpServers?: string[] };
        agents[agent.name] = {
          description: agent.description,
          prompt: agent.prompt,
          tools: agent.tools,
          model: agent.model,
          mcpServers: agent.mcpServers,
        };
      }
    }
  }

  // Load and resolve MCP configs
  const mcpServers: Record<string, unknown> = {};
  for (const name of suitesToLoad) {
    const mcpPath = join(SUITES_DIR, name, 'mcp.json');
    if (await exists(mcpPath)) {
      const raw = JSON.parse(await readFile(mcpPath, 'utf-8')) as unknown;
      const config = parseMcpConfig(raw);
      for (const [key, entry] of Object.entries(config.mcpServers)) {
        mcpServers[`${name}_${key}`] = {
          command: entry.command,
          args: entry.args ?? [],
          env: entry.env ? resolveEnvVars(entry.env) : undefined,
        };
      }
    }
  }

  // Write resolved MCP config to temp file
  let tmpMcpDir: string | undefined;
  const claudeCliArgs: string[] = [];

  if (Object.keys(mcpServers).length > 0) {
    tmpMcpDir = await mkdtemp(join(tmpdir(), 'raven-test-'));
    const mcpConfigPath = join(tmpMcpDir, 'mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));
    claudeCliArgs.push('--mcp-config', mcpConfigPath);
  }

  if (Object.keys(agents).length > 0) {
    claudeCliArgs.push('--agents', JSON.stringify(agents));
  }

  // Add passthrough args
  claudeCliArgs.push(...claudeArgs);

  console.log(`\nLaunching claude with ${Object.keys(agents).length} agents and ${Object.keys(mcpServers).length} MCP servers\n`);
  console.log(`Agents: ${Object.keys(agents).join(', ')}`);
  console.log(`MCPs: ${Object.keys(mcpServers).join(', ')}`);
  console.log('');

  try {
    execFileSync('claude', claudeCliArgs, {
      stdio: 'inherit',
      env: { ...process.env },
    });
  } finally {
    if (tmpMcpDir) {
      await rm(tmpMcpDir, { recursive: true }).catch(() => {});
    }
  }
}

async function getAllEnabledSuites(): Promise<string[]> {
  const configPath = join(PROJECT_ROOT, 'config', 'suites.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, { enabled: boolean }>;
  const suites = Object.entries(config)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  // Always include _orchestrator
  suites.push('_orchestrator');
  return suites;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
