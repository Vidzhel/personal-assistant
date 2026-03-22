import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@raven/shared';

const log = createLogger('suite-update-checker');

const UPDATE_FILENAME = 'UPDATE.md';

export interface SuiteUpdateInfo {
  name: string;
  checkInstructions: string;
}

export interface SuiteUpdateReport {
  suitesWithUpdates: SuiteUpdateInfo[];
  suitesWithoutUpdates: string[];
  installedSuites: string[];
  checkedAt: string;
}

export async function checkSuiteUpdates(suitesDir: string): Promise<SuiteUpdateReport> {
  log.info(`Scanning suites in ${suitesDir}`);

  const suiteNames = await findSuites(suitesDir);
  const suitesWithUpdates: SuiteUpdateInfo[] = [];
  const suitesWithoutUpdates: string[] = [];

  for (const name of suiteNames) {
    const updatePath = join(suitesDir, name, UPDATE_FILENAME);
    const content = await readUpdateFile(updatePath);

    if (content) {
      suitesWithUpdates.push({
        name,
        checkInstructions: extractSummary(content),
      });
    } else {
      suitesWithoutUpdates.push(name);
    }
  }

  log.info(
    `Suite scan: ${String(suitesWithUpdates.length)} with UPDATE.md, ${String(suitesWithoutUpdates.length)} without`,
  );

  return {
    suitesWithUpdates,
    suitesWithoutUpdates,
    installedSuites: suiteNames,
    checkedAt: new Date().toISOString(),
  };
}

async function findSuites(suitesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(suitesDir);
    const suites: string[] = [];

    for (const entry of entries) {
      // Skip non-suite entries (config files, etc.)
      if (entry.startsWith('.') || entry.endsWith('.ts') || entry.endsWith('.json')) continue;

      const entryPath = join(suitesDir, entry);
      const entryStat = await stat(entryPath);
      if (entryStat.isDirectory()) {
        suites.push(entry);
      }
    }

    return suites.sort();
  } catch {
    log.warn(`Could not read suites directory: ${suitesDir}`);
    return [];
  }
}

async function readUpdateFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function extractSummary(content: string): string {
  // Extract first non-empty, non-heading line as summary, or first heading
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('# ')) {
      // Return the heading text
      return trimmed.slice(2).trim();
    }
    // Return first substantive line, truncated
    const MAX_SUMMARY_LENGTH = 200;
    return trimmed.length > MAX_SUMMARY_LENGTH
      ? trimmed.slice(0, MAX_SUMMARY_LENGTH) + '...'
      : trimmed;
  }

  return 'Update instructions available';
}
