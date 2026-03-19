import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getLogDir, createLogger } from '@raven/shared';

const log = createLogger('api:logs');

const DEFAULT_LINES = 200;
const MAX_LINES = 1000;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

interface LogEntry {
  level: number;
  levelLabel: string;
  time: number;
  component?: string;
  msg: string;
  [key: string]: unknown;
}

interface LogQueryParams {
  lines?: string;
  level?: string;
  component?: string;
  search?: string;
}

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const LEVEL_NAME_TO_NUM: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// eslint-disable-next-line complexity -- filter chain is inherently branchy
function parseNdjson(content: string, filters: LogQueryParams, maxLines: number): LogEntry[] {
  const lines = content.split('\n').filter((l) => l.trim());
  const entries: LogEntry[] = [];
  const minLevel = filters.level ? (LEVEL_NAME_TO_NUM[filters.level] ?? 0) : 0;

  for (let i = lines.length - 1; i >= 0 && entries.length < maxLines; i--) {
    try {
      const entry = JSON.parse(lines[i]) as LogEntry;
      entry.levelLabel = PINO_LEVELS[entry.level] ?? 'unknown';

      if (minLevel && entry.level < minLevel) continue;
      if (filters.component && entry.component !== filters.component) continue;
      if (filters.search && !entry.msg.toLowerCase().includes(filters.search.toLowerCase()))
        continue;

      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

function isValidFilename(name: string): boolean {
  return !name.includes('/') && !name.includes('..') && !name.includes('\\');
}

function countLines(content: string): number {
  return content.split('\n').filter((l) => l.trim()).length;
}

// eslint-disable-next-line max-lines-per-function -- route registration group
export function registerLogRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: LogQueryParams }>('/api/logs', async (req) => {
    const dir = getLogDir();
    if (!dir) return { lines: [], total: 0, error: 'File logging not initialized' };

    const maxLines = Math.min(Number(req.query.lines ?? DEFAULT_LINES), MAX_LINES);

    try {
      const content = await readFile(resolve(dir, 'raven'), 'utf-8');
      const entries = parseNdjson(content, req.query, maxLines);
      return { lines: entries, total: countLines(content) };
    } catch (err) {
      log.debug(`Failed to read current log file: ${err}`);
      return { lines: [], total: 0 };
    }
  });

  app.get('/api/logs/files', async () => {
    const dir = getLogDir();
    if (!dir) return [];

    try {
      const files = await readdir(dir);
      const results = await Promise.all(
        files.map(async (name) => {
          const fileStat = await stat(resolve(dir, name));
          return { name, size: fileStat.size, modified: fileStat.mtimeMs };
        }),
      );
      return results.sort((a, b) => b.modified - a.modified);
    } catch {
      return [];
    }
  });

  app.get<{ Params: { filename: string }; Querystring: LogQueryParams }>(
    '/api/logs/:filename',
    async (req, reply) => {
      const dir = getLogDir();
      if (!dir)
        return reply.status(HTTP_BAD_REQUEST).send({ error: 'File logging not initialized' });

      const { filename } = req.params;
      if (!isValidFilename(filename)) {
        return reply.status(HTTP_BAD_REQUEST).send({ error: 'Invalid filename' });
      }

      const maxLines = Math.min(Number(req.query.lines ?? DEFAULT_LINES), MAX_LINES);

      try {
        const content = await readFile(resolve(dir, filename), 'utf-8');
        const entries = parseNdjson(content, req.query, maxLines);
        return { lines: entries, total: countLines(content) };
      } catch {
        return reply.status(HTTP_NOT_FOUND).send({ error: 'Log file not found' });
      }
    },
  );
}
