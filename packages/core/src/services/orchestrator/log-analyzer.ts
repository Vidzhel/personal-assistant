import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createLogger } from '@raven/shared';

const log = createLogger('log-analyzer');

const DAYS_TO_ANALYZE = 7;
const MS_PER_DAY = 86_400_000;
const PINO_LEVEL_WARN = 40;
const PINO_LEVEL_ERROR = 50;
const MAX_RECURRING_ERRORS = 20;
const SILENT_FAILURE_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

export interface RecurringError {
  component: string;
  pattern: string;
  count: number;
  lastSeen: string;
}

export interface SilentFailure {
  component: string;
  lastEntry: string;
}

export interface LogAnalysisResult {
  recurringErrors: RecurringError[];
  silentFailures: SilentFailure[];
  totalErrors: number;
  totalWarnings: number;
}

interface LogEntry {
  level: number;
  time: number;
  component?: string;
  msg?: string;
}

export async function analyzeLogs(logDir: string): Promise<LogAnalysisResult> {
  log.info(`Analyzing logs from ${logDir}`);

  const cutoffMs = Date.now() - DAYS_TO_ANALYZE * MS_PER_DAY;
  const logFiles = await findLogFiles(logDir);

  if (logFiles.length === 0) {
    log.warn('No log files found');
    return { recurringErrors: [], silentFailures: [], totalErrors: 0, totalWarnings: 0 };
  }

  const errorMap: ErrorMap = new Map();
  const componentLastSeen = new Map<string, number>();
  let totalErrors = 0;
  let totalWarnings = 0;

  const state: LogAnalysisState = {
    errorMap,
    componentLastSeen,
    countCallback: (isError) => {
      if (isError) {
        totalErrors++;
      } else {
        totalWarnings++;
      }
    },
  };

  for (const filePath of logFiles) {
    await processLogFile(filePath, cutoffMs, state);
  }

  const recurringErrors = buildRecurringErrors(errorMap);
  const silentFailures = detectSilentFailures(componentLastSeen);

  log.info(
    `Analysis complete: ${String(recurringErrors.length)} recurring errors, ${String(silentFailures.length)} silent failures`,
  );

  return { recurringErrors, silentFailures, totalErrors, totalWarnings };
}

async function findLogFiles(logDir: string): Promise<string[]> {
  try {
    const entries = await readdir(logDir);
    const logFiles: string[] = [];

    for (const entry of entries) {
      if (entry.startsWith('raven') && entry.endsWith('.log')) {
        const filePath = join(logDir, entry);
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          logFiles.push(filePath);
        }
      }
    }

    return logFiles;
  } catch {
    log.warn(`Could not read log directory: ${logDir}`);
    return [];
  }
}

interface ErrorRecord {
  component: string;
  pattern: string;
  count: number;
  lastSeen: number;
}

type ErrorMap = Map<string, ErrorRecord>;

interface LogAnalysisState {
  errorMap: ErrorMap;
  componentLastSeen: Map<string, number>;
  countCallback: (isError: boolean) => void;
}

function recordLogEntry(entry: LogEntry, component: string, state: LogAnalysisState): void {
  const existingLastSeen = state.componentLastSeen.get(component);
  if (!existingLastSeen || entry.time > existingLastSeen) {
    state.componentLastSeen.set(component, entry.time);
  }

  if (entry.level >= PINO_LEVEL_ERROR) {
    state.countCallback(true);
    trackError(state.errorMap, {
      component,
      message: entry.msg ?? 'Unknown error',
      time: entry.time,
    });
  } else if (entry.level >= PINO_LEVEL_WARN) {
    state.countCallback(false);
  }
}

function processLogLine(line: string, cutoffMs: number, state: LogAnalysisState): void {
  if (!line.trim()) return;

  try {
    const entry = JSON.parse(line) as LogEntry;
    if (!entry.time || entry.time < cutoffMs) return;

    recordLogEntry(entry, entry.component ?? 'unknown', state);
  } catch {
    // Skip malformed lines
  }
}

async function processLogFile(
  filePath: string,
  cutoffMs: number,
  state: LogAnalysisState,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    processLogLine(line, cutoffMs, state);
  }
}

function trackError(
  errorMap: ErrorMap,
  entry: { component: string; message: string; time: number },
): void {
  // Normalize message to create grouping pattern (strip UUIDs, numbers, timestamps)
  const pattern = normalizeMessage(entry.message);
  const key = `${entry.component}::${pattern}`;

  const existing = errorMap.get(key);
  if (existing) {
    existing.count++;
    if (entry.time > existing.lastSeen) {
      existing.lastSeen = entry.time;
    }
  } else {
    errorMap.set(key, { component: entry.component, pattern, count: 1, lastSeen: entry.time });
  }
}

function normalizeMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '<TIMESTAMP>')
    .replace(/\b\d{4,}\b/g, '<NUM>')
    .trim();
}

function buildRecurringErrors(errorMap: ErrorMap): RecurringError[] {
  return [...errorMap.values()]
    .filter((e) => e.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_RECURRING_ERRORS)
    .map((e) => ({
      component: e.component,
      pattern: e.pattern,
      count: e.count,
      lastSeen: new Date(e.lastSeen).toISOString(),
    }));
}

function detectSilentFailures(componentLastSeen: Map<string, number>): SilentFailure[] {
  const silentThreshold = Date.now() - SILENT_FAILURE_HOURS * MS_PER_HOUR;
  const failures: SilentFailure[] = [];

  for (const [component, lastSeen] of componentLastSeen) {
    if (lastSeen < silentThreshold) {
      failures.push({
        component,
        lastEntry: new Date(lastSeen).toISOString(),
      });
    }
  }

  return failures.sort((a, b) => a.lastEntry.localeCompare(b.lastEntry));
}
