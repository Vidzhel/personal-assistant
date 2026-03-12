/**
 * Interactive suite testing helper.
 *
 * Usage:
 *   npx tsx scripts/test-suite.ts <suite-name> [claude-args...]
 *   npx tsx scripts/test-suite.ts task-management -p "List my tasks"
 *   npx tsx scripts/test-suite.ts task-management --print
 *   npx tsx scripts/test-suite.ts _orchestrator
 *   npx tsx scripts/test-suite.ts --list
 *
 * Resolves a suite's TS agent definitions and MCP configs,
 * then launches `claude` with the appropriate --agents and --mcp-config flags.
 *
 * Flags:
 *   --print   Print the resolved `claude` command instead of launching it.
 *   --list    List available suites.
 */

import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import {
  resolveEnvVars,
  parseMcpConfig,
  namespaceMcpKey,
  rewriteAgentMcpRefs,
} from '@raven/shared';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const SUITES_DIR = join(PROJECT_ROOT, 'suites');
const SUITE_DEBUG_DIR = join(PROJECT_ROOT, '.suite-debug');

// Load .env from project root before resolving any env vars
dotenv.config({ path: join(PROJECT_ROOT, '.env') });

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: npx tsx scripts/test-suite.ts <suite-name> [claude-args...]');
    console.log('       npx tsx scripts/test-suite.ts --list');
    console.log('       npx tsx scripts/test-suite.ts task-management -p "List my tasks"');
    console.log('       npx tsx scripts/test-suite.ts task-management --print');
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

  // Extract --print flag, pass everything else through to claude
  const printMode = args.includes('--print');
  const claudeArgs = args.slice(1).filter((a) => a !== '--print');

  const suiteDir = join(SUITES_DIR, suiteName);

  if (!(await exists(suiteDir))) {
    console.error(`Suite not found: ${suiteName}`);
    console.error(`Available: ${(await readdir(SUITES_DIR)).join(', ')}`);
    process.exit(1);
  }

  const isOrchestrator = suiteName === '_orchestrator';
  const suitesToLoad = isOrchestrator ? await getAllEnabledSuites() : [suiteName];

  // Load and resolve MCP configs
  // Single-suite mode: use local keys (e.g. "ticktick") so agent tools match directly
  // Orchestrator mode: namespace keys (e.g. "task-management_ticktick") and rewrite agent tools
  const mcpServers: Record<string, unknown> = {};
  const suiteLocalToNamespaced = new Map<string, Map<string, string>>();

  for (const name of suitesToLoad) {
    const mcpPath = join(SUITES_DIR, name, 'mcp.json');
    if (!(await exists(mcpPath))) continue;

    const raw = JSON.parse(await readFile(mcpPath, 'utf-8')) as unknown;
    const config = parseMcpConfig(raw);
    const localToNamespaced = new Map<string, string>();

    for (const [localKey, entry] of Object.entries(config.mcpServers)) {
      const resolvedKey = isOrchestrator ? namespaceMcpKey(name, localKey) : localKey;
      localToNamespaced.set(localKey, resolvedKey);

      mcpServers[resolvedKey] = {
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ? resolveEnvVars(entry.env) : undefined,
      };
    }

    suiteLocalToNamespaced.set(name, localToNamespaced);
  }

  // Load agents from suites
  const agents: Record<
    string,
    {
      description: string;
      prompt: string;
      tools?: string[];
      model?: string;
      mcpServers?: string[];
    }
  > = {};

  for (const name of suitesToLoad) {
    const agentsDir = join(SUITES_DIR, name, 'agents');
    if (!(await exists(agentsDir))) continue;

    const localToNamespaced = suiteLocalToNamespaced.get(name);
    const files = await readdir(agentsDir);

    for (const file of files.filter((f) => f.endsWith('.ts'))) {
      const mod = await import(join(agentsDir, file));
      const agent = mod.default as {
        name: string;
        description: string;
        prompt: string;
        tools?: string[];
        model?: string;
        mcpServers?: string[];
      };

      // In orchestrator mode, rewrite local names → namespaced names
      let tools = agent.tools;
      let agentMcpServers = agent.mcpServers;
      if (isOrchestrator && localToNamespaced) {
        const rewritten = rewriteAgentMcpRefs(
          { tools: tools ?? [], mcpServers: agentMcpServers },
          localToNamespaced,
        );
        tools = rewritten.tools;
        agentMcpServers = rewritten.mcpServers;
      }

      agents[agent.name] = {
        description: agent.description,
        prompt: agent.prompt,
        tools,
        model: agent.model,
        mcpServers: agentMcpServers,
      };
    }
  }

  // Build claude CLI args
  const claudeCliArgs: string[] = [];
  let mcpConfigPath: string | undefined;

  if (Object.keys(mcpServers).length > 0) {
    await mkdir(SUITE_DEBUG_DIR, { recursive: true });
    mcpConfigPath = join(SUITE_DEBUG_DIR, 'mcp.json');
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));
    claudeCliArgs.push('--mcp-config', mcpConfigPath);
  }

  if (Object.keys(agents).length > 0) {
    claudeCliArgs.push('--agents', JSON.stringify(agents));
  }

  claudeCliArgs.push(...claudeArgs);

  console.log(
    `\nSuite: ${suiteName} | ${Object.keys(agents).length} agents, ${Object.keys(mcpServers).length} MCP servers`,
  );
  console.log(`Agents: ${Object.keys(agents).join(', ') || '(none)'}`);
  console.log(`MCPs: ${Object.keys(mcpServers).join(', ') || '(none)'}`);

  if (printMode) {
    // Print the full command for copy-paste
    const parts = ['claude'];
    for (const arg of claudeCliArgs) {
      // Quote args that contain spaces or special chars
      if (arg.includes(' ') || arg.includes('{') || arg.includes('"')) {
        parts.push(`'${arg}'`);
      } else {
        parts.push(arg);
      }
    }
    console.log('\n--- Command (copy-paste into terminal) ---\n');
    console.log(parts.join(' \\\n  '));
    console.log('');
    if (mcpConfigPath) {
      console.log(`MCP config written to: ${mcpConfigPath}`);
    }
    process.exit(0);
  }

  // Launch claude interactively
  console.log('');
  execFileSync('claude', claudeCliArgs, {
    stdio: 'inherit',
    env: { ...process.env, CLAUDECODE: undefined },
  });
}

async function getAllEnabledSuites(): Promise<string[]> {
  const configPath = join(PROJECT_ROOT, 'config', 'suites.json');
  const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<
    string,
    { enabled: boolean }
  >;
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
