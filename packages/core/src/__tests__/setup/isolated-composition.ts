import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AppConfig } from '../../config.ts';
import type { RavenOverrides } from '../../raven.ts';
import type { AgentBackend } from '../../agent-manager/agent-backend.ts';

export const sdkBackends = new WeakSet<AgentBackend>();

function fail(reason: string): never {
  throw new Error(
    `Unsafe createRaven test: ${reason}. Use createRavenTestFixture and a fake backend.`,
  );
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve existing ancestors too, so a not-yet-created DB under a symlink is caught. */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return resolve(canonical(parent), relative(parent, path));
}

function rejectSymlinks(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail('fixture trees must not contain symlinks');
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) rejectSymlinks(resolve(path, name));
  }
}

export function assertIsolatedComposition(config: AppConfig, overrides: RavenOverrides): void {
  if (typeof overrides.agentBackend !== 'function')
    fail('an explicit fake agentBackend is required');
  if (sdkBackends.has(overrides.agentBackend)) fail('the real SDK agentBackend is forbidden');
  const fields = ['dataDir', 'dbPath', 'projectsDir', 'libraryDir', 'configDir'] as const;
  for (const field of fields) {
    if (!overrides[field] || !isAbsolute(overrides[field])) fail(`absolute ${field} is required`);
  }
  const root = assertIsolatedRoot(overrides.dataDir!);
  const paths = fields.map((field) => overrides[field]!);
  paths.push(resolve(root, config.SESSION_PATH), resolve(root, config.DATABASE_PATH));
  for (const path of paths) {
    if (!isWithin(root, canonical(path)))
      fail('all definition, config, DB and session paths must stay inside dataDir');
  }
}

/** Used before fixture construction too: the fixture itself is a filesystem writer. */
export function assertIsolatedRoot(path: string): string {
  if (!isAbsolute(path)) fail('an absolute dataDir is required');
  const root = canonical(path);
  const tempRoot = realpathSync(tmpdir());
  const checkout = realpathSync(resolve(import.meta.dirname, '../../../../..'));
  if (root === tempRoot || !isWithin(tempRoot, root) || isWithin(checkout, root)) {
    fail('dataDir must be a dedicated temporary directory outside the checkout');
  }
  if (!existsSync(root) || !lstatSync(root).isDirectory()) fail('dataDir must already exist');
  rejectSymlinks(path);
  return root;
}
