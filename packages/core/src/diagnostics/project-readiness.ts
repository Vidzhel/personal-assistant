import { constants, accessSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import {
  META_PROJECT_ID,
  type DatabaseInterface,
  type AgentReadiness,
  type CapabilityReadiness,
  type NamedAgent,
  type McpServerConfig,
  type ProjectReadinessReport,
  type ProjectWorkspace,
  type ReadinessDefinitionDiagnostic,
  type ReadinessFinding,
  type ReadinessRequirement,
  type ReadinessSource,
  type ReadinessState,
  type WorkspaceReadiness,
} from '@raven/shared';
import type { AgentResolver } from '../agent-registry/agent-resolver.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import {
  environmentReferences,
  materializeMcpServerConfig,
} from '../capability-library/mcp-config.ts';
import {
  probeMcpTools,
  type McpToolsProbeInput,
  type McpToolsProbeResult,
} from './mcp-tools-probe.ts';
import type { DefinitionDiagnostic } from './definition-diagnostics.ts';
import { inspectMcpEntrypoint } from './mcp-entrypoint.ts';
import { redactSecrets } from './redact-secrets.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createProjectFileService } from '../project-manager/project-files-service.ts';
import type { ProjectWorkspaceStore } from '../project-manager/project-workspace.ts';
import type {
  WorkspaceExecution,
  WorkspaceExecutionResolver,
} from '../project-manager/workspace-execution.ts';

const MAX_SOURCES = 32;
const MAX_REMOTE_PROBES = 4;
const MAX_CONFIGURED_SOURCES = MAX_SOURCES - 1;
const MAX_CONTEXT_INDEXES = 12;
const MAX_ERROR_LENGTH = 240;
const MAX_ERROR_INPUT_LENGTH = 65_536;
const DEFAULT_CONTEXT_INDEXES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'README.md',
  'index.md',
] as const;
const BLOCKED_NATIVE_OPERATIONS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const AUTH_CONFIGURATION_NAME = /auth|credential|password|secret|token|api[-_]?key/i;

export interface ProjectReadinessDeps {
  workspaceExecution: WorkspaceExecutionResolver;
  workspaceStore: ProjectWorkspaceStore;
  namedAgentStore: NamedAgentStore;
  agentResolver: AgentResolver;
  capabilityLibrary: CapabilityLibrary;
  executionLogger: ExecutionLogger;
  projectRegistry: ProjectRegistry;
  projectRoot: string;
  db?: DatabaseInterface;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  probeHttpMcp?: (input: McpToolsProbeInput) => Promise<McpToolsProbeResult>;
}

interface ReadinessContext {
  deps: ProjectReadinessDeps;
  projectId: string;
  env: Readonly<Record<string, string | undefined>>;
  findings: ReadinessFinding[];
  executionCwd?: string;
  signal?: AbortSignal;
  probes: Map<string, Promise<McpToolsProbeResult>>;
}

function finding(input: ReadinessFinding): ReadinessFinding {
  return input;
}

export function sanitizeReadinessError(error: unknown): string {
  return redactSecrets(error, {
    maxInputLength: MAX_ERROR_INPUT_LENGTH,
    maxOutputLength: MAX_ERROR_LENGTH,
  });
}

function isExecutable(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(
  command: string,
  options: { projectRoot: string; path?: string },
): string | undefined {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const candidate = isAbsolute(command)
      ? resolve(command)
      : resolve(options.projectRoot, command);
    return isExecutable(candidate) ? candidate : undefined;
  }
  for (const directory of (options.path ?? '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function configurationRequirement(
  key: string,
  configuredValue: string,
  env: Readonly<Record<string, string | undefined>>,
): ReadinessRequirement {
  const references = environmentReferences(configuredValue);
  const configured =
    references.length === 0
      ? configuredValue.trim().length > 0
      : references.every((name) => Boolean(env[name]?.trim()));
  const name = references.length > 0 ? references.join(', ') : key;
  return {
    kind: 'configuration',
    name,
    state: configured ? 'configured' : 'unavailable',
    ...(!configured && { correction: `Set ${name} for this integration.` }),
  };
}

function executableRequirement(name: string, context: ReadinessContext): ReadinessRequirement {
  const available = resolveExecutable(name, {
    projectRoot: context.deps.projectRoot,
    path: context.env.PATH,
  });
  return {
    kind: 'executable',
    name,
    state: available ? 'verified' : 'unavailable',
    ...(!available && { correction: `Install ${name} where the Raven process can execute it.` }),
  };
}

function authenticationRequirement(
  name: string,
  configuration: ReadinessRequirement[],
): ReadinessRequirement {
  const configured = configuration.every((item) => item.state === 'configured');
  return {
    kind: 'authentication',
    name,
    state: configured ? 'unverified' : 'unavailable',
    correction: configured
      ? 'Credentials are configured; this static check does not test account access.'
      : 'Configure every required credential before verifying authentication.',
  };
}

function requirementState(requirements: ReadinessRequirement[]): ReadinessState {
  if (requirements.some((item) => item.state === 'failed')) return 'failed';
  if (requirements.some((item) => item.state === 'unavailable')) return 'unavailable';
  if (requirements.some((item) => item.state === 'unverified')) return 'unverified';
  if (requirements.some((item) => item.state === 'configured')) return 'configured';
  return 'verified';
}

function requirementFinding(
  capability: string,
  requirement: ReadinessRequirement,
): ReadinessFinding | undefined {
  if (requirement.state === 'verified' || requirement.state === 'configured') return undefined;
  if (requirement.state === 'failed')
    return finding({
      code: `${requirement.kind}-failed`,
      severity: 'warning',
      scope: `capability:${capability}`,
      message: `${requirement.kind} check failed: ${requirement.name}`,
      correction: requirement.correction ?? 'Check the integration configuration and retry.',
    });
  const unavailable = requirement.state === 'unavailable';
  return finding({
    code: unavailable ? `${requirement.kind}-unavailable` : `${requirement.kind}-unverified`,
    severity: unavailable ? 'warning' : 'info',
    scope: `capability:${capability}`,
    message: unavailable
      ? `${requirement.kind} requirement is unavailable: ${requirement.name}`
      : `${requirement.kind} has not been verified: ${requirement.name}`,
    correction:
      requirement.correction ?? `Verify the ${requirement.name} ${requirement.kind} requirement.`,
  });
}

function capabilityFailure(
  context: ReadinessContext,
  name: string,
  message: string,
): ReadinessFinding {
  return finding({
    code: 'capability-unavailable',
    severity: 'warning',
    scope: `capability:${name}`,
    message,
    correction: `Correct the ${name} skill definition or remove it from the selected agent.`,
  });
}

function sharedHttpProbe(
  context: ReadinessContext,
  mcpName: string,
  config: McpServerConfig,
): Promise<McpToolsProbeResult> | undefined {
  const existing = context.probes.get(mcpName);
  if (existing) return existing;
  if (context.probes.size >= MAX_REMOTE_PROBES) return undefined;
  const pending = Promise.resolve()
    .then(() => {
      const resolved = materializeMcpServerConfig(config, context.env);
      if (resolved.type !== 'http') throw new Error('Expected an HTTP MCP definition');
      return (context.deps.probeHttpMcp ?? probeMcpTools)({
        url: resolved.url,
        headers: resolved.headers ?? {},
        signal: context.signal,
      });
    })
    .catch((): McpToolsProbeResult => ({
      state: 'failed',
      stage: 'connection',
      reason: 'The MCP readiness check failed. Check its configuration and retry.',
    }));
  context.probes.set(mcpName, pending);
  return pending;
}

function failedHttpRequirements(
  mcpName: string,
  result: Extract<McpToolsProbeResult, { state: 'failed' }>,
): ReadinessRequirement[] {
  return [
    {
      kind: 'authentication',
      name: mcpName,
      state: result.stage === 'authentication' ? 'failed' : 'unverified',
      correction:
        result.stage === 'authentication'
          ? result.reason
          : 'Authentication could not be fully verified by this check.',
    },
    ...(result.stage !== 'authentication'
      ? [
          {
            kind: result.stage,
            name: mcpName,
            state: 'failed' as const,
            correction: result.reason,
          },
        ]
      : []),
  ];
}

async function httpRequirements(
  context: ReadinessContext,
  config: McpServerConfig,
  input: { mcpName: string; configuration: ReadinessRequirement[]; expectedTools: string[] },
): Promise<ReadinessRequirement[]> {
  const { mcpName, configuration, expectedTools } = input;
  if (configuration.some((item) => item.state === 'unavailable'))
    return [authenticationRequirement(mcpName, configuration)];
  const pending = sharedHttpProbe(context, mcpName, config);
  if (!pending)
    return [
      {
        kind: 'authentication',
        name: mcpName,
        state: 'unverified',
        correction:
          'Only four remote integrations are checked per report. Inspect remaining integrations separately.',
      },
    ];
  const result = await pending;
  if (result.state === 'failed') return failedHttpRequirements(mcpName, result);
  const requirements: ReadinessRequirement[] = [
    { kind: 'authentication', name: mcpName, state: 'verified' },
  ];
  if (result.state === 'verified') {
    for (const requirement of configuration) requirement.state = 'verified';
    const missing = expectedTools.filter((name) => !result.toolNames.includes(name));
    requirements.push({
      kind: 'tools',
      name: mcpName,
      state: missing.length > 0 || result.toolNames.length === 0 ? 'failed' : 'verified',
      toolCount: result.toolNames.length,
      ...(result.toolNames.length === 0 && {
        correction:
          'The MCP server exposed no tools. Check account access and provider configuration.',
      }),
      ...(missing.length > 0 && {
        correction: `The server is missing ${String(missing.length)} tools required by this skill. Refresh its definition and verify the provider catalog.`,
      }),
    });
  }
  return requirements;
}

function stdioRequirements(
  context: ReadinessContext,
  config: Exclude<McpServerConfig, { type: 'http' }>,
  input: { mcpName: string; configuration: ReadinessRequirement[] },
): ReadinessRequirement[] {
  const { mcpName, configuration } = input;
  const requirements = [
    executableRequirement(config.command, context),
    ...inspectMcpEntrypoint(
      config.command,
      config.args,
      context.executionCwd ?? context.deps.projectRoot,
    ),
  ];
  const authentication = configuration.filter((item) => AUTH_CONFIGURATION_NAME.test(item.name));
  if (authentication.length > 0)
    requirements.push(authenticationRequirement(mcpName, authentication));
  return requirements;
}

async function mcpRequirements(
  context: ReadinessContext,
  mcpName: string,
  expectedTools: string[],
): Promise<{ requirements: ReadinessRequirement[]; findings: ReadinessFinding[] }> {
  try {
    const config = context.deps.capabilityLibrary.getMcpServerConfig(mcpName);
    if (!config) throw new Error(`MCP definition is unavailable: ${mcpName}`);
    const configuration = Object.entries(
      (config.type === 'http' ? config.headers : config.env) ?? {},
    ).map(([key, value]) => configurationRequirement(key, value, context.env));
    const requirements: ReadinessRequirement[] = [
      { kind: 'definition', name: `MCP ${mcpName}`, state: 'verified' },
      ...configuration,
    ];
    requirements.push(
      ...(config.type === 'http'
        ? await httpRequirements(context, config, { mcpName, configuration, expectedTools })
        : stdioRequirements(context, config, { mcpName, configuration })),
    );
    return { requirements, findings: [] };
  } catch (error) {
    return {
      requirements: [{ kind: 'definition', name: mcpName, state: 'unavailable' }],
      findings: [capabilityFailure(context, mcpName, sanitizeReadinessError(error))],
    };
  }
}

function unavailableCapability(
  context: ReadinessContext,
  name: string,
  message: string,
): CapabilityReadiness {
  return {
    name,
    displayName: name,
    state: 'unavailable',
    requirements: [{ kind: 'definition', name, state: 'unavailable' }],
    findings: [capabilityFailure(context, name, message)],
  };
}

function bindingReadiness(
  context: ReadinessContext,
  agent: NamedAgent,
  name: string,
): { requirements: ReadinessRequirement[]; findings: ReadinessFinding[] } {
  try {
    context.deps.agentResolver.resolveAgentCapabilities({ ...agent, skills: [name] });
    return { requirements: [], findings: [] };
  } catch (error) {
    return {
      requirements: [{ kind: 'definition', name: `${name}:bindings`, state: 'unavailable' }],
      findings: [capabilityFailure(context, name, sanitizeReadinessError(error))],
    };
  }
}

async function inspectCapability(input: {
  context: ReadinessContext;
  agent: NamedAgent;
  name: string;
}): Promise<CapabilityReadiness> {
  const { context, agent, name } = input;
  let skill: ReturnType<CapabilityLibrary['getSkill']>;
  try {
    skill = context.deps.capabilityLibrary.getSkill(name);
  } catch (error) {
    return unavailableCapability(context, name, sanitizeReadinessError(error));
  }
  if (!skill) {
    return unavailableCapability(context, name, `Skill definition is unavailable: ${name}`);
  }
  const requirements: ReadinessRequirement[] = [
    { kind: 'definition', name, state: 'verified' },
    ...skill.config.systemDeps.map((dependency) => executableRequirement(dependency, context)),
  ];
  const findings: ReadinessFinding[] = [];
  for (const mcpName of skill.config.mcps) {
    const expectedTools =
      mcpName === 'ticktick'
        ? skill.config.actions
            .map((action) => action.name)
            .filter((action) => action.startsWith('ticktick:'))
            .map((action) => action.slice('ticktick:'.length).replaceAll('-', '_'))
        : [];
    const inspected = await mcpRequirements(context, mcpName, expectedTools);
    requirements.push(...inspected.requirements);
    findings.push(...inspected.findings);
  }
  const bindings = bindingReadiness(context, agent, name);
  requirements.push(...bindings.requirements);
  findings.push(...bindings.findings);
  findings.push(
    ...requirements.flatMap((requirement) => {
      const item = requirementFinding(name, requirement);
      return item ? [item] : [];
    }),
  );
  return {
    name,
    displayName: skill.config.displayName,
    state: requirementState(requirements),
    requirements,
    findings,
  };
}

function contextIndexes(
  context: ReadinessContext,
  sourceId: string,
  configured: string[] | undefined,
): ReadinessSource['contextIndexes'] {
  const service = createProjectFileService(context.deps.workspaceStore);
  const candidates = configured ?? [...DEFAULT_CONTEXT_INDEXES];
  const indexes = candidates.slice(0, MAX_CONTEXT_INDEXES).map((path) => {
    try {
      const info = service.getInfo({ projectId: context.projectId, sourceId, path });
      return {
        path,
        state: info.type === 'file' ? ('verified' as const) : ('unavailable' as const),
      };
    } catch {
      return { path, state: 'unavailable' as const };
    }
  });
  if (candidates.length > MAX_CONTEXT_INDEXES) {
    context.findings.push(
      finding({
        code: 'context-index-list-truncated',
        severity: 'info',
        scope: `workspace:source:${sourceId}`,
        message: `Only the first ${String(MAX_CONTEXT_INDEXES)} context indexes were inspected.`,
        correction: 'Remove unused context indexes or inspect the remaining files directly.',
      }),
    );
  }
  return configured === undefined ? indexes.filter((item) => item.state === 'verified') : indexes;
}

function homeSource(
  context: ReadinessContext,
  selectedSourceId: string | undefined,
): ReadinessSource {
  const service = createProjectFileService(context.deps.workspaceStore);
  let state: ReadinessState = 'verified';
  try {
    const root = service.getInfo({ projectId: context.projectId, sourceId: 'home', path: '' });
    const index = service.getInfo({
      projectId: context.projectId,
      sourceId: 'home',
      path: 'context.md',
    });
    if (root.type !== 'directory' || index.type !== 'file') state = 'unavailable';
  } catch {
    state = 'unavailable';
  }
  return {
    id: 'home',
    label: 'Managed project home',
    sourceType: 'folder',
    selected: selectedSourceId === undefined,
    state,
    contextIndexes: [
      { path: 'context.md', state: state === 'verified' ? 'verified' : 'unavailable' },
    ],
  };
}

function folderSource(
  context: ReadinessContext,
  source: ProjectWorkspace['sources'][number],
  selectedSourceId: string | undefined,
): ReadinessSource {
  const service = createProjectFileService(context.deps.workspaceStore);
  let state: ReadinessState = 'verified';
  try {
    const info = service.getInfo({ projectId: context.projectId, sourceId: source.id, path: '' });
    if (info.type !== 'directory') state = 'unavailable';
  } catch {
    state = 'unavailable';
    context.findings.push(
      finding({
        code: 'source-unavailable',
        severity: 'warning',
        scope: `workspace:source:${source.id}`,
        message: `The attached folder is unavailable: ${source.label}.`,
        correction: 'Restore its mount or update the source to a folder Raven can access.',
      }),
    );
  }
  const indexes = contextIndexes(context, source.id, source.contextFiles);
  if (source.contextFiles && indexes.some((item) => item.state === 'unavailable')) {
    context.findings.push(
      finding({
        code: 'context-index-unavailable',
        severity: 'warning',
        scope: `workspace:source:${source.id}`,
        message: `A configured context index is unavailable for ${source.label}.`,
        correction: 'Restore the configured context file or remove it from this source.',
      }),
    );
  }
  return {
    id: source.id,
    label: source.label,
    sourceType: source.sourceType,
    selected: source.id === selectedSourceId,
    state,
    contextIndexes: indexes,
  };
}

function unverifiedSource(
  context: ReadinessContext,
  source: ProjectWorkspace['sources'][number],
  selectedSourceId: string | undefined,
): ReadinessSource {
  context.findings.push(
    finding({
      code: 'source-unverified',
      severity: 'info',
      scope: `workspace:source:${source.id}`,
      message: `Source access has not been verified: ${source.label}.`,
      correction: 'Use the source through its configured integration to verify current access.',
    }),
  );
  return {
    id: source.id,
    label: source.label,
    sourceType: source.sourceType,
    selected: source.id === selectedSourceId,
    state: 'unverified',
    contextIndexes: [],
  };
}

function sourceReadiness(
  context: ReadinessContext,
  workspace: ProjectWorkspace,
): ReadinessSource[] {
  const selected = workspace.execution.sourceId;
  const sources = workspace.sources
    .slice(0, MAX_CONFIGURED_SOURCES)
    .map((source) =>
      source.sourceType === 'folder'
        ? folderSource(context, source, selected)
        : unverifiedSource(context, source, selected),
    );
  if (workspace.sources.length > MAX_CONFIGURED_SOURCES) {
    context.findings.push(
      finding({
        code: 'source-list-truncated',
        severity: 'info',
        scope: 'workspace:sources',
        message: `Only the first ${String(MAX_CONFIGURED_SOURCES)} configured sources were inspected.`,
        correction: 'Remove unused sources or inspect the remaining sources individually.',
      }),
    );
  }
  return [homeSource(context, selected), ...sources];
}

function blockedOperations(execution: WorkspaceExecution, agent?: NamedAgent): string[] {
  if (execution.mode !== 'default') return [];
  switch (agent?.bash?.access) {
    case 'full':
      return [];
    case 'scoped':
    case 'sandboxed':
      return BLOCKED_NATIVE_OPERATIONS.map((name) => `${name} outside configured scope`);
    default:
      return [...BLOCKED_NATIVE_OPERATIONS];
  }
}

function inspectWorkspace(
  context: ReadinessContext,
  agent?: NamedAgent,
): { readiness: WorkspaceReadiness; workspace?: ProjectWorkspace } {
  let workspace: ProjectWorkspace | undefined;
  try {
    workspace = context.deps.workspaceStore.getWorkspace(context.projectId);
    const execution = context.deps.workspaceExecution.resolve({
      projectId: context.projectId,
      namedAgentId: agent?.id,
      namedAgentRevision: agent?.definitionRevision,
    });
    context.executionCwd = execution.cwd;
    return {
      workspace,
      readiness: {
        state: 'verified',
        cwd: execution.cwd,
        mode: execution.mode,
        sourceId: workspace.execution.sourceId,
        settingSources: execution.settingSources,
        blockedOperations: blockedOperations(execution, agent),
        sources: sourceReadiness(context, workspace),
      },
    };
  } catch (error) {
    context.findings.push(
      finding({
        code: 'workspace-unavailable',
        severity: 'blocking',
        scope: 'workspace',
        message: sanitizeReadinessError(error),
        correction:
          'Restore the project directory or selected folder mount, then reload readiness.',
      }),
    );
    return {
      workspace,
      readiness: {
        state: 'unavailable',
        mode: workspace?.execution.mode,
        sourceId: workspace?.execution.sourceId,
        settingSources: [],
        blockedOperations: [...BLOCKED_NATIVE_OPERATIONS],
        sources: workspace ? sourceReadiness(context, workspace) : [],
      },
    };
  }
}

function inspectAgent(context: ReadinessContext): {
  readiness: AgentReadiness;
  agent?: NamedAgent;
} {
  try {
    const agent = context.deps.namedAgentStore.getDefaultAgent(context.projectId);
    return {
      agent,
      readiness: { state: 'verified', id: agent.id, name: agent.name, skills: [...agent.skills] },
    };
  } catch (error) {
    context.findings.push(
      finding({
        code: 'default-agent-unavailable',
        severity: 'blocking',
        scope: 'agent',
        message: sanitizeReadinessError(error),
        correction: 'Restore a valid default agent visible to this project.',
      }),
    );
    return { readiness: { state: 'unavailable', skills: [] } };
  }
}

function projectNodeId(registry: ProjectRegistry, projectId: string): string | undefined {
  const nodes = [registry.getGlobal(), ...registry.listProjects()];
  return nodes.find(
    (node) => (node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id)) === projectId,
  )?.id;
}

function belongsToInvalidProjectPath(path: string, invalidPaths: readonly string[]): boolean {
  return invalidPaths.some((invalid) => path === invalid || path.startsWith(`${invalid}/`));
}

export function resolveReadinessProjectPath(
  deps: Pick<ProjectReadinessDeps, 'db' | 'projectRegistry'>,
  projectId: string,
): string | undefined {
  const current = projectNodeId(deps.projectRegistry, projectId);
  if (current) return current;
  const invalidPaths = deps.projectRegistry.getInvalidProjectPaths();
  if (invalidPaths.includes(projectId)) return projectId;
  const cached = deps.db?.get<{ fs_path: string | null }>(
    'SELECT fs_path FROM projects WHERE id = ?',
    projectId,
  );
  return cached?.fs_path && belongsToInvalidProjectPath(cached.fs_path, invalidPaths)
    ? cached.fs_path
    : undefined;
}

function relevantDiagnostic(
  diagnostic: DefinitionDiagnostic,
  input: { nodeId?: string; skillNames: Set<string>; mcpNames: Set<string> },
): boolean {
  if (
    input.nodeId &&
    (diagnostic.path === input.nodeId || diagnostic.path.startsWith(`${input.nodeId}/`))
  ) {
    return true;
  }
  if (diagnostic.source === 'skill') {
    return [...input.skillNames].some((name) => diagnostic.path.includes(`/${name}/`));
  }
  if (diagnostic.source === 'mcp') {
    return [...input.mcpNames].some((name) => diagnostic.path === `mcps/${name}.json`);
  }
  return false;
}

function definitionDiagnostics(
  context: ReadinessContext,
  agent?: NamedAgent,
): ReadinessDefinitionDiagnostic[] {
  try {
    const skillNames = new Set(agent?.skills ?? []);
    const mcpNames = new Set(
      [...skillNames].flatMap(
        (name) => context.deps.capabilityLibrary.getSkill(name)?.config.mcps ?? [],
      ),
    );
    const nodeId =
      resolveReadinessProjectPath(context.deps, context.projectId) ?? context.projectId;
    return [
      ...context.deps.projectRegistry.getDefinitionDiagnostics(),
      ...context.deps.capabilityLibrary.getDefinitionDiagnostics(),
    ]
      .filter((item) => relevantDiagnostic(item, { nodeId, skillNames, mcpNames }))
      .map((item) => ({ ...item, message: sanitizeReadinessError(item.message) }));
  } catch (error) {
    context.findings.push(
      finding({
        code: 'definition-diagnostics-unavailable',
        severity: 'warning',
        scope: 'definitions',
        message: sanitizeReadinessError(error),
        correction: 'Reload the project and capability registries, then retry readiness.',
      }),
    );
    return [];
  }
}

function reportStatus(input: {
  findings: ReadinessFinding[];
  sources: ReadinessSource[];
  capabilities: CapabilityReadiness[];
  diagnostics: ReadinessDefinitionDiagnostic[];
}): ProjectReadinessReport['status'] {
  if (input.findings.some((item) => item.severity === 'blocking')) return 'blocked';
  if (
    input.findings.some((item) => item.severity === 'warning') ||
    input.sources.some((item) => item.state !== 'verified') ||
    input.capabilities.some((item) => item.state !== 'verified') ||
    input.diagnostics.length > 0
  ) {
    return 'degraded';
  }
  return 'ready';
}

export async function inspectProjectReadiness(
  deps: ProjectReadinessDeps,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectReadinessReport> {
  const findings: ReadinessFinding[] = [];
  const context: ReadinessContext = {
    deps,
    projectId,
    env: deps.env ?? process.env,
    findings,
    signal,
    probes: new Map(),
  };
  const agent = inspectAgent(context);
  const workspace = inspectWorkspace(context, agent.agent);
  const capabilities = await Promise.all(
    (agent.agent?.skills ?? []).map((name) =>
      inspectCapability({
        context,
        agent: agent.agent as NamedAgent,
        name,
      }),
    ),
  );
  for (const capability of capabilities) findings.push(...capability.findings);
  const diagnostics = definitionDiagnostics(context, agent.agent);
  return {
    projectId,
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
    status: reportStatus({
      findings,
      sources: workspace.readiness.sources,
      capabilities,
      diagnostics,
    }),
    workspace: workspace.readiness,
    agent: agent.readiness,
    capabilities,
    definitionDiagnostics: diagnostics,
    recentFailures: [],
    findings,
  };
}
