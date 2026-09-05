import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { createLogger, AgentYamlSchema } from '@raven/shared';
import type { AgentYaml } from '@raven/shared';
import { readProjectTextFile } from '../project-manager/project-file-read.ts';
import { ProjectMutationError } from '../project-manager/project-mutation.ts';

const { dump, load: yamlLoad } = yaml;
const log = createLogger('agent-yaml-store');
const LINE_WIDTH = 120;
const MAX_AGENT_BYTES = 1_048_576;
const AGENT_FILE_MODE = 0o600;

export interface AgentYamlStore {
  createAgent(projectPath: string, agent: AgentYaml): Promise<string>;
  updateAgent(
    projectPath: string,
    agentName: string,
    updates: Partial<AgentYaml>,
  ): Promise<AgentYaml>;
  deleteAgent(projectPath: string, agentName: string): Promise<void>;
  resolveAgentFile(projectPath: string, agentName: string): string;
}

function assertCanonicalDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(directory) !== resolve(directory)
  ) {
    throw new ProjectMutationError(`Agent directory is unsafe: ${directory}`);
  }
}

function assertCanonicalFile(filePath: string): void {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(filePath) !== resolve(filePath)) {
    throw new ProjectMutationError(`Agent definition is unsafe: ${filePath}`);
  }
}

function flush(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureAgentsDirectory(projectPath: string): string {
  assertCanonicalDirectory(projectPath);
  const agentsPath = join(projectPath, 'agents');
  if (!existsSync(agentsPath)) mkdirSync(agentsPath);
  assertCanonicalDirectory(agentsPath);
  return agentsPath;
}

function fileCandidates(projectPath: string, agentName: string): string[] {
  return [
    join(projectPath, 'agents', agentName, 'agent.yaml'),
    join(projectPath, 'agents', `${agentName}.yaml`),
  ];
}

function currentAgentFile(projectPath: string, agentName: string): string {
  const filePath = fileCandidates(projectPath, agentName).find((candidate) =>
    existsSync(candidate),
  );
  if (!filePath) throw new ProjectMutationError(`Agent definition not found: ${agentName}`);
  assertCanonicalFile(filePath);
  return filePath;
}

function writeExclusive(filePath: string, bytes: string): void {
  if (Buffer.byteLength(bytes, 'utf8') > MAX_AGENT_BYTES) {
    throw new ProjectMutationError('Agent definition exceeds the maximum size');
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'wx', AGENT_FILE_MODE);
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ProjectMutationError(`Agent definition already exists: ${filePath}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicReplace(filePath: string, expected: string, replacement: string): void {
  assertCanonicalFile(filePath);
  const current = readProjectTextFile(filePath, MAX_AGENT_BYTES);
  if (current !== expected)
    throw new ProjectMutationError('Agent definition changed during update');
  const temporary = join(dirname(filePath), `.agent-${randomUUID()}.tmp`);
  try {
    writeExclusive(temporary, replacement);
    const afterWrite = readProjectTextFile(filePath, MAX_AGENT_BYTES);
    if (afterWrite !== expected)
      throw new ProjectMutationError('Agent definition changed during update');
    renameSync(temporary, filePath);
    flush(dirname(filePath));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function parseCurrent(filePath: string, agentName: string): { bytes: string; agent: AgentYaml } {
  const bytes = readProjectTextFile(filePath, MAX_AGENT_BYTES);
  if (bytes === undefined)
    throw new ProjectMutationError(`Agent definition not found: ${agentName}`);
  const agent = AgentYamlSchema.parse(yamlLoad(bytes));
  if (agent.name !== agentName)
    throw new ProjectMutationError(`Agent definition identity changed: ${agentName}`);
  return { bytes, agent };
}

function resolveAgentFile(projectPath: string, agentName: string): string {
  return (
    fileCandidates(projectPath, agentName).find((candidate) => existsSync(candidate)) ??
    fileCandidates(projectPath, agentName)[1]
  );
}

async function createAgent(projectPath: string, agent: AgentYaml): Promise<string> {
  const validated = AgentYamlSchema.parse(agent);
  const agentsPath = ensureAgentsDirectory(projectPath);
  const agentDir = join(agentsPath, validated.name);
  if (existsSync(agentDir)) {
    assertCanonicalDirectory(agentDir);
    throw new ProjectMutationError(`Agent definition already exists: ${validated.name}`);
  }
  const flatPath = join(agentsPath, `${validated.name}.yaml`);
  if (existsSync(flatPath)) {
    assertCanonicalFile(flatPath);
    throw new ProjectMutationError(`Agent definition already exists: ${validated.name}`);
  }
  mkdirSync(agentDir);
  assertCanonicalDirectory(agentDir);
  const filePath = join(agentDir, 'agent.yaml');
  writeExclusive(filePath, dump(validated, { lineWidth: LINE_WIDTH }));
  flush(agentDir);
  flush(agentsPath);
  log.info(`Created agent YAML: ${validated.name} at ${filePath}`);
  return filePath;
}

async function updateAgent(
  projectPath: string,
  agentName: string,
  updates: Partial<AgentYaml>,
): Promise<AgentYaml> {
  assertCanonicalDirectory(projectPath);
  const filePath = currentAgentFile(projectPath, agentName);
  const current = parseCurrent(filePath, agentName);
  const merged = AgentYamlSchema.parse({ ...current.agent, ...updates, name: agentName });
  atomicReplace(filePath, current.bytes, dump(merged, { lineWidth: LINE_WIDTH }));
  log.info(`Updated agent YAML: ${agentName} at ${filePath}`);
  return merged;
}

async function deleteAgent(projectPath: string, agentName: string): Promise<void> {
  assertCanonicalDirectory(projectPath);
  const filePath = currentAgentFile(projectPath, agentName);
  unlinkSync(filePath);
  flush(dirname(filePath));
  const agentDir = dirname(filePath);
  if (agentDir !== join(projectPath, 'agents')) {
    try {
      rmdirSync(agentDir);
      flush(dirname(agentDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
    }
  }
  log.info(`Deleted agent YAML: ${agentName} at ${filePath}`);
}

export function createAgentYamlStore(): AgentYamlStore {
  return { resolveAgentFile, createAgent, updateAgent, deleteAgent };
}
