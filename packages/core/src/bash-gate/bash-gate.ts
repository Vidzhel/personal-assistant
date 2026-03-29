import type { BashAccess } from '@raven/shared';

import { parseCommand } from './command-parser.ts';
import { checkMandatoryDenies } from './mandatory-denies.ts';

export interface BashGateResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Lightweight glob matcher.
 * - `*` matches anything except `/`
 * - `**` matches anything including `/`
 * - All other characters match literally (case-sensitive)
 */
export function globMatch(pattern: string, value: string): boolean {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        // skip trailing slash after ** (e.g., **/)
        if (pattern[i] === '/') i++;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    // Escape regex special chars
    if ('.+?^${}()|[]\\'.includes(ch)) {
      re += '\\';
    }
    re += ch;
    i++;
  }
  re += '$';
  return new RegExp(re).test(value);
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => globMatch(p, value));
}

/**
 * Check whether a bash command is allowed given a BashAccess config.
 *
 * Logic:
 * 1. Parse the command
 * 2. Check mandatory denies (always enforced)
 * 3. Apply access-level rules:
 *    - none: block all
 *    - sandboxed: command allowlist + path allowlist (deny takes precedence)
 *    - scoped: path allowlist only (deny takes precedence)
 *    - full: allow (mandatory denies already checked)
 */
export function checkBashAccess(command: string, config: BashAccess): BashGateResult {
  const chain = parseCommand(command);

  // Always check mandatory denies first
  const mandatory = checkMandatoryDenies(chain);
  if (mandatory.denied) {
    return { allowed: false, reason: mandatory.reason };
  }

  switch (config.access) {
    case 'none':
      return { allowed: false, reason: 'Bash access is disabled (access: none)' };

    case 'sandboxed':
      return checkSandboxed(chain, config);

    case 'scoped':
      return checkScoped(chain, config);

    case 'full':
      return { allowed: true };

    default:
      return { allowed: false, reason: `Unknown access level: ${String(config.access)}` };
  }
}

function checkSandboxed(
  chain: ReturnType<typeof parseCommand>,
  config: BashAccess,
): BashGateResult {
  // Check each binary against allowed/denied commands
  for (const binary of chain.allBinaries) {
    // Denied takes precedence
    if (config.deniedCommands.length > 0 && matchesAny(config.deniedCommands, binary)) {
      return { allowed: false, reason: `Command "${binary}" is denied` };
    }

    // Must match at least one allowed command
    if (config.allowedCommands.length > 0 && !matchesAny(config.allowedCommands, binary)) {
      return { allowed: false, reason: `Command "${binary}" is not in the allowed list` };
    }
  }

  // Check paths
  return checkPaths(chain, config);
}

function checkScoped(chain: ReturnType<typeof parseCommand>, config: BashAccess): BashGateResult {
  return checkPaths(chain, config);
}

function checkPaths(chain: ReturnType<typeof parseCommand>, config: BashAccess): BashGateResult {
  for (const path of chain.allPaths) {
    // Denied paths take precedence
    if (config.deniedPaths.length > 0 && matchesAny(config.deniedPaths, path)) {
      return { allowed: false, reason: `Path "${path}" is denied` };
    }

    // If allowedPaths is set, path must match at least one
    if (config.allowedPaths.length > 0 && !matchesAny(config.allowedPaths, path)) {
      return { allowed: false, reason: `Path "${path}" is not in the allowed paths` };
    }
  }

  return { allowed: true };
}
