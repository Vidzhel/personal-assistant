import { accessSync, constants, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ReadinessRequirement } from '@raven/shared';

const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3']);
const VALUELESS_FLAGS = new Set([
  '--experimental-strip-types',
  '--no-warnings',
  '--enable-source-maps',
  '-u',
  '-B',
]);

/** Inspect only a known interpreter's literal script argument; never evaluate shell syntax. */
export function inspectMcpEntrypoint(
  command: string,
  args: string[],
  cwd: string,
): ReadinessRequirement[] {
  if (!INTERPRETERS.has(basename(command))) return [];
  const script = args.find((arg) => !VALUELESS_FLAGS.has(arg));
  if (!script || script.startsWith('-') || !/\.(?:[cm]?js|ts|py)$/u.test(script)) return [];
  const path = resolve(cwd, script);
  let available: boolean;
  try {
    available = statSync(path).isFile();
    accessSync(path, constants.R_OK);
  } catch {
    available = false;
  }
  return [
    {
      kind: 'definition',
      name: `MCP entrypoint: ${script}`,
      state: available ? 'verified' : 'unavailable',
      ...(!available && {
        correction: `Install or build ${script}, or configure an absolute entrypoint path accessible from the project's working directory.`,
      }),
    },
  ];
}
