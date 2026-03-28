import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  createLogger,
  parseMcpConfig,
  parseActions,
  resolveEnvVars,
  namespaceMcpKey,
  validateAgentMcpRefs,
  type ResolvedSuiteManifest,
  type ResolvedAgentDefinition,
  type ActionDefinition,
  type McpServerConfig,
} from '@raven/shared';

const log = createLogger('suite-loader');

export interface ResolvedPlugin {
  type: 'local';
  path: string;
}

export interface LoadedSuite {
  manifest: ResolvedSuiteManifest;
  agents: ResolvedAgentDefinition[];
  mcpServers: Record<string, McpServerConfig>;
  actions: ActionDefinition[];
  schedules: SuiteSchedule[];
  vendorPlugins: ResolvedPlugin[];
  suiteDir: string;
}

export function resolveVendorPlugins(vendorPlugins: string[], vendorDir: string): ResolvedPlugin[] {
  return vendorPlugins.map((name) => ({
    type: 'local' as const,
    path: resolve(vendorDir, name),
  }));
}

export interface SuiteSchedule {
  id: string;
  name: string;
  cron: string;
  taskType: string;
  enabled: boolean;
}

/**
 * Loads a single suite from a directory on disk.
 * Dynamically imports suite.ts and agents/*.ts using --experimental-strip-types.
 */
export async function loadSuite(suiteDir: string): Promise<LoadedSuite> {
  const absDir = resolve(suiteDir);

  // Load suite manifest
  const manifestPath = join(absDir, 'suite.ts');
  const manifestModule = await importTs(manifestPath);
  const manifest = manifestModule.default as ResolvedSuiteManifest;
  log.info(`Loading suite: ${manifest.name} (${manifest.displayName})`);

  // Validate required env vars before loading anything else
  if (manifest.requiresEnv.length > 0) {
    const missing = manifest.requiresEnv.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      throw new Error(
        `Suite "${manifest.name}" cannot load: missing required env vars: ${missing.join(', ')}`,
      );
    }
  }

  // Load agents
  const agents = await loadAgents(absDir);

  // Load MCP config
  const mcpServers = await loadMcpConfig(absDir, manifest.name);

  // Validate agent MCP references before namespacing
  const localMcpKeys = await getLocalMcpKeys(absDir);
  for (const agent of agents) {
    validateAgentMcpRefs(agent, localMcpKeys, manifest.name);
  }

  // Load actions
  const actions = await loadActions(absDir);

  // Load schedules
  const schedules = await loadSchedules(absDir);

  // Resolve vendor plugins relative to project vendor directory
  const vendorDir = resolve(absDir, '..', '..', 'vendor');
  const vendorPlugins = resolveVendorPlugins(manifest.vendorPlugins ?? [], vendorDir);

  return { manifest, agents, mcpServers, actions, schedules, vendorPlugins, suiteDir: absDir };
}

async function loadAgents(suiteDir: string): Promise<ResolvedAgentDefinition[]> {
  const agentsDir = join(suiteDir, 'agents');
  if (!(await exists(agentsDir))) return [];

  const files = await readdir(agentsDir);
  const tsFiles = files.filter((f) => f.endsWith('.ts'));
  const agents: ResolvedAgentDefinition[] = [];

  for (const file of tsFiles) {
    const agentModule = await importTs(join(agentsDir, file));
    const agent = agentModule.default as ResolvedAgentDefinition;
    agents.push(agent);
    log.debug(`  Agent loaded: ${agent.name}`);
  }

  return agents;
}

async function loadMcpConfig(
  suiteDir: string,
  suiteName: string,
): Promise<Record<string, McpServerConfig>> {
  const mcpPath = join(suiteDir, 'mcp.json');
  if (!(await exists(mcpPath))) return {};

  const raw = JSON.parse(await readFile(mcpPath, 'utf-8')) as unknown;
  const config = parseMcpConfig(raw);

  // Namespace MCP servers with suite name and resolve env vars
  const servers: Record<string, McpServerConfig> = {};
  for (const [key, entry] of Object.entries(config.mcpServers)) {
    servers[namespaceMcpKey(suiteName, key)] = {
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ? resolveEnvVars(entry.env) : undefined,
    };
  }

  return servers;
}

async function getLocalMcpKeys(suiteDir: string): Promise<Set<string>> {
  const mcpPath = join(suiteDir, 'mcp.json');
  if (!(await exists(mcpPath))) return new Set();

  const raw = JSON.parse(await readFile(mcpPath, 'utf-8')) as unknown;
  const config = parseMcpConfig(raw);
  return new Set(Object.keys(config.mcpServers));
}

async function loadActions(suiteDir: string): Promise<ActionDefinition[]> {
  const actionsPath = join(suiteDir, 'actions.json');
  if (!(await exists(actionsPath))) return [];

  const raw = JSON.parse(await readFile(actionsPath, 'utf-8')) as unknown;
  return parseActions(raw);
}

async function loadSchedules(suiteDir: string): Promise<SuiteSchedule[]> {
  const schedulesPath = join(suiteDir, 'schedules.json');
  if (!(await exists(schedulesPath))) return [];

  const raw = JSON.parse(await readFile(schedulesPath, 'utf-8')) as unknown;
  return raw as SuiteSchedule[];
}

async function importTs(filePath: string): Promise<Record<string, unknown>> {
  const absPath = resolve(filePath);
  // Dynamic import works with --experimental-strip-types (dev) or tsx
  return await import(absPath);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
