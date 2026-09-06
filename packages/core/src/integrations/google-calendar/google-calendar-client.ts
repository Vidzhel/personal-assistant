import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 10_000;
const BYTES_PER_KIBIBYTE = 1024;
const MAX_TOTAL_OUTPUT_BYTES = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
const MAX_PAGES = 4;
const MAX_TOOL_DURATION_MS = 40_000;
const FORCE_KILL_AFTER_MS = 1_000;
const DAYS_PER_MAX_RANGE = 31;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1_000;
const AUTHENTICATION_FAILURE_MESSAGE =
  'Google Calendar authentication expired or was revoked; reconnect Google Calendar';
const PERMISSION_FAILURE_MESSAGE =
  'Google Calendar permission is insufficient; reconnect Google Calendar with read-only Calendar access';
const MAX_RANGE_MS =
  DAYS_PER_MAX_RANGE *
  HOURS_PER_DAY *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MILLISECONDS_PER_SECOND;

export interface GwsRunRequest {
  command: 'gws';
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type GwsRunner = (request: GwsRunRequest) => Promise<string>;

export interface CalendarSummary {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  timeZone?: string;
  accessRole?: string;
  selected?: boolean;
  hidden?: boolean;
  primary?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  iCalUID?: string;
  eventType?: string;
  selfResponseStatus?: string;
  recurringEventId?: string;
  originalStartTime?: EventDateTime;
  start?: EventDateTime;
  end?: EventDateTime;
  transparency?: string;
}

export interface EventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface PartialResult<T> {
  complete: boolean;
  reason?: string;
  items: T[];
  calendarId?: string;
}

interface PageResponse {
  items?: unknown[];
  nextPageToken?: string;
}

interface PaginationOptions<T> {
  paramsFor: (pageToken?: string) => Record<string, unknown>;
  fixedArgs: string[];
  parseItem: (value: unknown) => T | null;
  signal?: AbortSignal;
}

class TrustedProviderError extends Error {}

export interface GoogleCalendarClientOptions {
  runner?: GwsRunner;
  env?: NodeJS.ProcessEnv;
  maxPages?: number;
  timeoutMs?: number;
}

export class GoogleCalendarClient {
  private readonly runner: GwsRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxPages: number;
  private readonly timeoutMs: number;

  constructor(options: GoogleCalendarClientOptions = {}) {
    this.runner = options.runner ?? runGws;
    this.env = calendarEnvironment(options.env ?? process.env);
    this.maxPages = options.maxPages ?? MAX_PAGES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const credentials = this.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
    if (!credentials?.trim()) {
      throw new Error('GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE is required');
    }
  }

  async listCalendars(signal?: AbortSignal): Promise<PartialResult<CalendarSummary>> {
    return this.collectPages({
      paramsFor: (pageToken) => ({
        showHidden: true,
        showDeleted: false,
        ...(pageToken && { pageToken }),
      }),
      fixedArgs: ['calendar', 'calendarList', 'list'],
      parseItem: parseCalendar,
      signal,
    });
  }

  async listEvents(input: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
    signal?: AbortSignal;
  }): Promise<PartialResult<CalendarEvent>> {
    validateRange(input.timeMin, input.timeMax);
    validateTimeZone(input.timeZone);
    if (!input.calendarId.trim()) throw new Error('calendarId is required');
    const result = await this.collectPages({
      paramsFor: (pageToken) => ({
        calendarId: input.calendarId,
        timeMin: input.timeMin,
        timeMax: input.timeMax,
        timeZone: input.timeZone,
        singleEvents: true,
        showDeleted: false,
        orderBy: 'startTime',
        ...(pageToken && { pageToken }),
      }),
      fixedArgs: ['calendar', 'events', 'list'],
      parseItem: (value) => parseEvent(value, input.calendarId),
      signal: input.signal,
    });
    return { ...result, calendarId: input.calendarId };
  }

  private async collectPages<T>(options: PaginationOptions<T>): Promise<PartialResult<T>> {
    const items: T[] = [];
    const seenTokens = new Set<string>();
    const startedAt = Date.now();
    let remainingOutputBytes = MAX_TOTAL_OUTPUT_BYTES;
    let pageToken: string | undefined;
    for (let page = 1; page <= this.maxPages; page += 1) {
      let pageResult: { response: PageResponse; bytes: number };
      try {
        pageResult = await requestCalendarPage({
          ...options,
          pageToken,
          startedAt,
          remainingOutputBytes,
          runner: this.runner,
          env: this.env,
          timeoutMs: this.timeoutMs,
        });
      } catch (error) {
        const reason =
          error instanceof TrustedProviderError
            ? `${error.message} (page ${page})`
            : `Google Calendar request failed on page ${page}`;
        return { items, complete: false, reason };
      }
      remainingOutputBytes -= pageResult.bytes;
      const malformed = appendPageItems({ items, response: pageResult.response, options, page });
      if (malformed) return malformed;
      const { response } = pageResult;
      if (!response.nextPageToken) return { items, complete: true };
      if (seenTokens.has(response.nextPageToken)) {
        return { items, complete: false, reason: 'Google Calendar returned a repeated page token' };
      }
      seenTokens.add(response.nextPageToken);
      pageToken = response.nextPageToken;
    }
    return {
      items,
      complete: false,
      reason: `Google Calendar pagination exceeded ${this.maxPages} pages`,
    };
  }
}

async function requestCalendarPage<T>(options: {
  paramsFor: PaginationOptions<T>['paramsFor'];
  fixedArgs: string[];
  pageToken?: string;
  signal?: AbortSignal;
  startedAt: number;
  remainingOutputBytes: number;
  runner: GwsRunner;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ response: PageResponse; bytes: number }> {
  const remainingDurationMs = MAX_TOOL_DURATION_MS - (Date.now() - options.startedAt);
  if (remainingDurationMs <= 0) throw new Error('Google Calendar request exceeded its time budget');
  const output = await options.runner({
    command: 'gws',
    args: [
      ...options.fixedArgs,
      '--params',
      JSON.stringify(options.paramsFor(options.pageToken)),
      '--format',
      'json',
    ],
    env: options.env,
    signal: options.signal,
    timeoutMs: Math.min(options.timeoutMs, remainingDurationMs),
    maxOutputBytes: options.remainingOutputBytes,
  });
  const bytes = Buffer.byteLength(output);
  if (bytes > options.remainingOutputBytes) {
    throw new Error('Google Calendar response exceeded its output budget');
  }
  return { response: parsePage(output), bytes };
}

function appendPageItems<T>(input: {
  items: T[];
  response: PageResponse;
  options: PaginationOptions<T>;
  page: number;
}): PartialResult<T> | undefined {
  try {
    for (const value of input.response.items ?? []) {
      const item = input.options.parseItem(value);
      if (item) input.items.push(item);
    }
  } catch {
    return {
      items: input.items,
      complete: false,
      reason: `Google Calendar returned malformed items on page ${input.page}`,
    };
  }
  return undefined;
}

export const runGws: GwsRunner = async (request) => {
  if (request.signal?.aborted) throw new Error('Google Calendar request aborted');
  return executeGws(request);
};

function executeGws(request: GwsRunRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      shell: false,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failure: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: Error): void => {
      failure ??= reason;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        forceKillTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, FORCE_KILL_AFTER_MS);
        forceKillTimer.unref?.();
      }
    };
    const abort = (): void => terminate(new Error('Google Calendar request aborted'));
    request.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => terminate(new Error('Google Calendar request timed out')),
      request.timeoutMs,
    );
    timer.unref?.();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      request.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    collectProcessOutput({ child, chunks, maxOutputBytes: request.maxOutputBytes, terminate });
    child.stderr.resume();
    child.on('error', () => {
      failure ??= new Error('Google Calendar provider process failed');
    });
    child.on('close', (code) => {
      const error = providerCloseError({ code, failure, chunks });
      if (error) finish(error);
      else finish();
    });
  });
}

function providerCloseError(input: {
  code: number | null;
  failure?: Error;
  chunks: Buffer[];
}): Error | undefined {
  if (input.failure || input.code === 0) return input.failure;
  return (
    classifyProviderFailure(Buffer.concat(input.chunks).toString('utf8')) ??
    new Error('Google Calendar provider request failed')
  );
}

function classifyProviderFailure(output: string): TrustedProviderError | undefined {
  const normalized = output.toLowerCase();
  if (normalized.includes('invalid_grant') || normalized.includes('invalid_client')) {
    return new TrustedProviderError(AUTHENTICATION_FAILURE_MESSAGE);
  }
  if (
    normalized.includes('insufficient_scope') ||
    /"(?:code|status)"\s*:\s*(?:403|"permission_denied")/i.test(output)
  ) {
    return new TrustedProviderError(PERMISSION_FAILURE_MESSAGE);
  }
  return undefined;
}

function collectProcessOutput(input: {
  child: ReturnType<typeof spawn>;
  chunks: Buffer[];
  maxOutputBytes: number;
  terminate: (reason: Error) => void;
}): void {
  let size = 0;
  input.child.stdout?.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > input.maxOutputBytes) {
      input.terminate(new Error('Google Calendar response exceeded its output budget'));
    } else {
      input.chunks.push(chunk);
    }
  });
}

function parsePage(output: string): PageResponse {
  const value: unknown = JSON.parse(output);
  if (!isRecord(value)) throw new Error('Google Calendar returned an invalid response');
  if ('error' in value) throw new Error('Google Calendar returned a provider error');
  const knownEmptyKind =
    value.items === undefined &&
    (value.kind === 'calendar#events' || value.kind === 'calendar#calendarList');
  if (!Array.isArray(value.items) && !knownEmptyKind) {
    throw new Error('Google Calendar returned invalid items');
  }
  if (value.nextPageToken !== undefined && typeof value.nextPageToken !== 'string') {
    throw new Error('Google Calendar returned an invalid page token');
  }
  return {
    items: (value.items as unknown[] | undefined) ?? [],
    nextPageToken: value.nextPageToken as string | undefined,
  };
}

function parseCalendar(value: unknown): CalendarSummary {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('Google Calendar returned a malformed calendar');
  }
  return compact({
    id: value.id,
    summary: stringValue(value.summary),
    description: stringValue(value.description),
    location: stringValue(value.location),
    timeZone: stringValue(value.timeZone),
    accessRole: stringValue(value.accessRole),
    selected: booleanValue(value.selected),
    hidden: booleanValue(value.hidden),
    primary: booleanValue(value.primary),
  });
}

function parseEvent(value: unknown, calendarId: string): CalendarEvent | null {
  if (isRecord(value) && value.status === 'cancelled') return null;
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('Google Calendar returned a malformed event');
  }
  return compact({
    id: value.id,
    calendarId,
    status: stringValue(value.status),
    summary: stringValue(value.summary),
    description: stringValue(value.description),
    location: stringValue(value.location),
    htmlLink: stringValue(value.htmlLink),
    iCalUID: stringValue(value.iCalUID),
    eventType: stringValue(value.eventType),
    selfResponseStatus: selfResponseStatus(value.attendees),
    recurringEventId: stringValue(value.recurringEventId),
    originalStartTime: parseDateTime(value.originalStartTime),
    start: parseDateTime(value.start),
    end: parseDateTime(value.end),
    transparency: stringValue(value.transparency),
  });
}

function parseDateTime(value: unknown): EventDateTime | undefined {
  if (!isRecord(value)) return undefined;
  const result = compact({
    date: stringValue(value.date),
    dateTime: stringValue(value.dateTime),
    timeZone: stringValue(value.timeZone),
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function validateRange(timeMin: string, timeMax: string): void {
  const timestamp = z.iso.datetime({ offset: true });
  if (!timestamp.safeParse(timeMin).success || !timestamp.safeParse(timeMax).success) {
    throw new Error('timeMin and timeMax must be RFC3339 timestamps');
  }
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  if (max <= min) throw new Error('timeMax must be after timeMin');
  if (max - min > MAX_RANGE_MS) throw new Error('Event range must not exceed 31 days');
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format();
  } catch {
    throw new Error('timeZone must be a valid IANA timezone');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function selfResponseStatus(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const attendee = value.find((item) => isRecord(item) && item.self === true);
  return isRecord(attendee) ? stringValue(attendee.responseStatus) : undefined;
}

function calendarEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const credentials = source.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  const allowed = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TZ',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
  ]);
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key)));
  if (credentials) {
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credentials;
    env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = join(dirname(credentials), 'gws-cache');
  }
  return env;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
