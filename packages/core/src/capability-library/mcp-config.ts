import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { McpDefinition, McpServerConfig } from '@raven/shared';

const ENVIRONMENT_REFERENCE_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/gu;
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3']);
const VALUELESS_FLAGS = new Set([
  '--experimental-strip-types',
  '--no-warnings',
  '--enable-source-maps',
  '-u',
  '-B',
]);
const SCRIPT_EXTENSION_RE = /\.(?:[cm]?js|ts|py)$/u;
const RAVEN_CODE_ROOT = resolve(import.meta.dirname, '../../../..');
const LAST_C0_CONTROL_CHARACTER = 31;
const DELETE_CONTROL_CHARACTER = 127;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= LAST_C0_CONTROL_CHARACTER || code === DELETE_CONTROL_CHARACTER;
  });
}

export interface McpConfigurationStatus {
  configured: boolean;
  missingEnvironment: string[];
}

export type MaterializedMcpServerConfig =
  | {
      type: 'stdio';
      command: string;
      args: string[];
      env?: Record<string, string>;
      alwaysLoad: true;
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      alwaysLoad: true;
    };

export function environmentReferences(value: string): string[] {
  return [...value.matchAll(ENVIRONMENT_REFERENCE_RE)].map((match) => match[1]);
}

function configTemplates(config: McpServerConfig): string[] {
  return Object.values(config.type === 'http' ? (config.headers ?? {}) : (config.env ?? {}));
}

export function mcpEnvironmentReferences(config: McpServerConfig): string[] {
  return [...new Set(configTemplates(config).flatMap(environmentReferences))].sort();
}

export function getMcpConfigurationStatus(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): McpConfigurationStatus {
  const missingEnvironment = mcpEnvironmentReferences(config)
    .filter((name) => !env[name]?.trim())
    .sort();
  return { configured: missingEnvironment.length === 0, missingEnvironment };
}

function interpolateTemplate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENVIRONMENT_REFERENCE_RE, (_reference, name: string) => {
    const replacement = env[name];
    if (!replacement?.trim()) throw new Error(`Missing MCP environment configuration: ${name}`);
    if (hasControlCharacter(replacement)) {
      throw new Error(`Invalid control character in MCP environment configuration: ${name}`);
    }
    return replacement;
  });
}

function materializeRecord(
  templates: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!templates || Object.keys(templates).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(templates).map(([name, value]) => [name, interpolateTemplate(value, env)]),
  );
}

export function materializeMcpServerConfig(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): MaterializedMcpServerConfig {
  if (config.type === 'http') {
    const status = getMcpConfigurationStatus(config, env);
    if (!status.configured) {
      throw new Error(
        `Missing MCP environment configuration: ${status.missingEnvironment.join(', ')}`,
      );
    }
    const headers = materializeRecord(config.headers, env);
    return {
      type: 'http',
      url: config.url,
      ...(headers ? { headers } : {}),
      alwaysLoad: true,
    };
  }

  // Preserve legacy stdio behavior for missing optional values while keeping
  // live values out of events and run-history objects.
  const stdioEnv = config.env
    ? Object.fromEntries(
        Object.entries(config.env).map(([name, value]) => [
          name,
          value.replace(ENVIRONMENT_REFERENCE_RE, (_reference, environmentName: string) => {
            const replacement = env[environmentName] ?? '';
            if (hasControlCharacter(replacement)) {
              throw new Error(
                `Invalid control character in MCP environment configuration: ${environmentName}`,
              );
            }
            return replacement;
          }),
        ]),
      )
    : undefined;
  return {
    type: 'stdio',
    command: config.command,
    args: config.args,
    ...(stdioEnv && Object.keys(stdioEnv).length > 0 ? { env: stdioEnv } : {}),
    alwaysLoad: true,
  };
}

function containedPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function scriptArgumentIndex(command: string, args: string[]): number | undefined {
  if (!INTERPRETERS.has(basename(command))) return undefined;
  const index = args.findIndex((arg) => !VALUELESS_FLAGS.has(arg));
  const script = index < 0 ? undefined : args[index];
  if (!script || script.startsWith('-') || !SCRIPT_EXTENSION_RE.test(script)) return undefined;
  return index;
}

function anchoredScriptPath(script: string, libraryRoot: string): string {
  if (isAbsolute(script)) return script;
  const libraryPrefix = `library${sep}`;
  const normalized = script.split('/').join(sep);
  const base = normalized.startsWith(libraryPrefix) ? libraryRoot : RAVEN_CODE_ROOT;
  const suffix = normalized.startsWith(libraryPrefix)
    ? normalized.slice(libraryPrefix.length)
    : normalized;
  const path = resolve(base, suffix);
  if (!containedPath(base, path)) {
    throw new Error(`MCP entrypoint escapes its configured root: ${script}`);
  }
  return path;
}

function anchorStdioArgs(command: string, args: string[], libraryRoot: string): string[] {
  const index = scriptArgumentIndex(command, args);
  if (index === undefined) return [...args];
  const anchored = [...args];
  anchored[index] = anchoredScriptPath(anchored[index], resolve(libraryRoot));
  return anchored;
}

/** Create the secret-free task/event representation for a loaded definition. */
export function createMcpServerConfig(
  definition: McpDefinition,
  libraryRoot: string,
): McpServerConfig {
  if (definition.type === 'http') {
    return {
      type: 'http',
      url: definition.url,
      ...(Object.keys(definition.headers).length > 0 ? { headers: { ...definition.headers } } : {}),
    };
  }
  return {
    type: definition.type,
    command: definition.command,
    args: anchorStdioArgs(definition.command, definition.args, libraryRoot),
    ...(Object.keys(definition.env).length > 0 ? { env: { ...definition.env } } : {}),
  };
}

/** Used by focused diagnostics/tests without executing or shell-expanding the entrypoint. */
export function isReadableAnchoredEntrypoint(config: McpServerConfig): boolean | undefined {
  if (config.type === 'http') return undefined;
  const index = scriptArgumentIndex(config.command, config.args);
  if (index === undefined) return undefined;
  const script = config.args[index];
  if (!isAbsolute(script)) return false;
  try {
    const canonical = realpathSync(script);
    if (!statSync(canonical).isFile()) return false;
    accessSync(canonical, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
