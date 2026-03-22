import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@raven/shared';

const execFile = promisify(execFileCb);

const log = createLogger('dependency-checker');

const EXEC_TIMEOUT_MS = 60_000;

export interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  updateType: 'patch' | 'minor' | 'major';
}

export interface Vulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  url: string;
  range: string;
}

export interface DependencyReport {
  outdated: OutdatedPackage[];
  vulnerabilities: Vulnerability[];
  checkedAt: string;
}

interface NpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
}

interface NpmAuditAdvisory {
  name?: string;
  severity?: string;
  title?: string;
  url?: string;
  range?: string;
}

interface NpmAuditV2Vuln {
  name?: string;
  severity?: string;
  via?: Array<NpmAuditAdvisory | string>;
  range?: string;
}

export async function checkDependencies(projectRoot: string): Promise<DependencyReport> {
  log.info('Checking dependencies');

  const [outdated, vulnerabilities] = await Promise.all([
    getOutdatedPackages(projectRoot),
    getVulnerabilities(projectRoot),
  ]);

  log.info(
    `Dependencies checked: ${String(outdated.length)} outdated, ${String(vulnerabilities.length)} vulnerabilities`,
  );

  return { outdated, vulnerabilities, checkedAt: new Date().toISOString() };
}

async function getOutdatedPackages(projectRoot: string): Promise<OutdatedPackage[]> {
  try {
    const { stdout } = await execFile('npm', ['outdated', '--json'], {
      cwd: projectRoot,
      timeout: EXEC_TIMEOUT_MS,
    });

    const data = JSON.parse(stdout || '{}') as Record<string, NpmOutdatedEntry>;
    return parseOutdated(data);
  } catch (err: unknown) {
    // npm outdated exits with code 1 when packages are outdated — that's normal
    if (isExecError(err) && err.stdout) {
      try {
        const data = JSON.parse(err.stdout) as Record<string, NpmOutdatedEntry>;
        return parseOutdated(data);
      } catch {
        log.error('Failed to parse npm outdated output');
      }
    }
    log.error(`npm outdated failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function getVulnerabilities(projectRoot: string): Promise<Vulnerability[]> {
  try {
    const { stdout } = await execFile('npm', ['audit', '--json'], {
      cwd: projectRoot,
      timeout: EXEC_TIMEOUT_MS,
    });

    return parseAudit(stdout || '{}');
  } catch (err: unknown) {
    // npm audit exits with non-zero when vulnerabilities exist — that's normal
    if (isExecError(err) && err.stdout) {
      try {
        return parseAudit(err.stdout);
      } catch {
        log.error('Failed to parse npm audit output');
      }
    }
    log.error(`npm audit failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function parseOutdated(data: Record<string, NpmOutdatedEntry>): OutdatedPackage[] {
  const results: OutdatedPackage[] = [];

  for (const [name, info] of Object.entries(data)) {
    if (!info.current || !info.latest) continue;

    const updateType = classifyUpdate(info.current, info.latest);
    results.push({
      name,
      current: info.current,
      wanted: info.wanted ?? info.latest,
      latest: info.latest,
      updateType,
    });
  }

  return results.sort((a, b) => {
    const order = { major: 0, minor: 1, patch: 2 };
    return order[a.updateType] - order[b.updateType];
  });
}

function parseAudit(jsonStr: string): Vulnerability[] {
  const data = JSON.parse(jsonStr) as { vulnerabilities?: Record<string, NpmAuditV2Vuln> };

  if (!data.vulnerabilities) return [];

  const results: Vulnerability[] = [];

  for (const [name, vuln] of Object.entries(data.vulnerabilities)) {
    const advisory = findAdvisory(vuln.via);
    if (!advisory) continue;

    results.push({
      name,
      severity: normalizeSeverity(vuln.severity ?? advisory.severity ?? 'info'),
      title: advisory.title ?? `Vulnerability in ${name}`,
      url: advisory.url ?? '',
      range: vuln.range ?? advisory.range ?? '',
    });
  }

  return results.sort((a, b) => {
    const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
    return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
  });
}

function findAdvisory(via: Array<NpmAuditAdvisory | string> | undefined): NpmAuditAdvisory | null {
  if (!via) return null;
  for (const item of via) {
    if (typeof item === 'object' && item.title) {
      return item;
    }
  }
  return null;
}

function classifyUpdate(current: string, latest: string): 'patch' | 'minor' | 'major' {
  const [curMajor, curMinor] = current.split('.').map(Number);
  const [latMajor, latMinor] = latest.split('.').map(Number);

  if (curMajor !== latMajor) return 'major';
  if (curMinor !== latMinor) return 'minor';
  return 'patch';
}

function normalizeSeverity(sev: string): Vulnerability['severity'] {
  const valid = ['info', 'low', 'moderate', 'high', 'critical'];
  return valid.includes(sev) ? (sev as Vulnerability['severity']) : 'info';
}

interface ExecError extends Error {
  stdout: string;
  stderr: string;
  code: number;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error && 'stdout' in err;
}
