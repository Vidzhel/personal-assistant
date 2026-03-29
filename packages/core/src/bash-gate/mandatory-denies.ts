import type { ParsedCommandChain } from './command-parser.ts';
import { globMatch } from './bash-gate.ts';

export const MANDATORY_DENIED_PATHS = ['.env', '.git', '.git/**'];
export const MANDATORY_DENIED_PATTERNS = ['rm -rf /'];

export function checkMandatoryDenies(chain: ParsedCommandChain): {
  denied: boolean;
  reason?: string;
} {
  // Check full command against mandatory deny patterns
  // Use regex to ensure 'rm -rf /' matches only bare '/' (end of string or followed by space)
  for (const pattern of MANDATORY_DENIED_PATTERNS) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}(?:\\s|$)`);
    if (re.test(chain.raw) || chain.raw.endsWith(pattern)) {
      return { denied: true, reason: `Command matches mandatory deny pattern: ${pattern}` };
    }
  }

  // Check all paths against mandatory denied paths
  for (const path of chain.allPaths) {
    for (const deniedPath of MANDATORY_DENIED_PATHS) {
      if (globMatch(deniedPath, path)) {
        return {
          denied: true,
          reason: `Path "${path}" matches mandatory denied path: ${deniedPath}`,
        };
      }
    }
  }

  return { denied: false };
}
