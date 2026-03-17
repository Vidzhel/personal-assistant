import { extname } from 'node:path';
import {
  generateId,
  createLogger,
  type IngestKnowledge,
  type RavenEvent,
  type KnowledgeIngestRequestEvent,
  type AgentTaskCompleteEvent,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';
import { extractFromFile, extractFromUrl, copyToMediaDir } from './content-extractor.ts';

const log = createLogger('ingestion');

const MAX_CONTENT_FOR_PROMPT = 30_000;
const INGESTION_TIMEOUT_MS = 120_000;

export interface IngestionDeps {
  knowledgeStore: KnowledgeStore;
  eventBus: EventBus;
  executionLogger: ExecutionLogger;
  mediaDir: string;
}

export interface IngestionProcessor {
  ingest: (input: IngestKnowledge) => Promise<{ taskId: string }>;
  start: () => void;
}

function deriveSource(input: IngestKnowledge): string {
  if (input.source) return input.source;
  switch (input.type) {
    case 'text':
      return 'manual';
    case 'voice-memo':
      return 'voice-memo';
    case 'url':
      return 'url';
    case 'file': {
      const ext = extname(input.filePath ?? '')
        .toLowerCase()
        .replace('.', '');
      return `file:${ext || 'unknown'}`;
    }
  }
}

function buildIngestionPrompt(params: {
  content: string;
  title?: string;
  tags?: string[];
  source: string;
  sourceFile?: string;
  sourceUrl?: string;
}): string {
  const { content, title, tags, source, sourceFile, sourceUrl } = params;
  const titleInstruction = title
    ? `Use exactly this title: "${title}"`
    : 'Generate a clear title from the content.';
  const tagInstruction = tags?.length
    ? `Include these hint tags: ${JSON.stringify(tags)}. Add more relevant ones.`
    : 'Generate from content themes.';
  const sourceInfo = [
    source,
    sourceFile ? `(file: ${sourceFile})` : '',
    sourceUrl ? `(url: ${sourceUrl})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const truncated = content.slice(0, MAX_CONTENT_FOR_PROMPT);

  return [
    'You are a knowledge ingestion agent for a personal knowledge management system. Analyze the following content and return a JSON object.',
    '',
    'Requirements:',
    `1. "title": A concise, descriptive title (max 100 chars). ${titleInstruction}`,
    `2. "tags": An array of 3-8 relevant tags (lowercase, single words or short hyphenated phrases). ${tagInstruction}`,
    '3. "summary": A 1-3 sentence summary of the key information.',
    '',
    `Source: ${sourceInfo}`,
    '',
    'Content to analyze:',
    '---',
    truncated,
    '---',
    '',
    'Return ONLY a valid JSON object, no markdown fencing, no explanation. Example:',
    '{"title": "SQLite Backup Strategies", "tags": ["database", "sqlite", "backup", "ops"], "summary": "Overview of backup approaches for SQLite databases including WAL mode considerations."}',
  ].join('\n');
}

interface ParsedIngestionResult {
  title: string;
  tags: string[];
  summary: string;
}

function parseIngestionResult(agentOutput: string): ParsedIngestionResult {
  const trimmed = agentOutput.trim();

  // Try direct parse
  try {
    return validateParsed(JSON.parse(trimmed));
  } catch {
    // continue
  }

  // Try extracting from markdown code fences
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  if (fenceMatch?.[1]) {
    try {
      return validateParsed(JSON.parse(fenceMatch[1]));
    } catch {
      // continue
    }
  }

  // Try finding first { to last }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return validateParsed(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)));
  }

  throw new Error('Failed to parse agent output as JSON');
}

function validateParsed(data: unknown): ParsedIngestionResult {
  const obj = data as Record<string, unknown>;
  if (typeof obj.title !== 'string') throw new Error('Missing or invalid title in agent output');
  if (!Array.isArray(obj.tags)) throw new Error('Missing or invalid tags in agent output');
  return {
    title: obj.title.trim(),
    tags: obj.tags.map((t: unknown) => String(t).toLowerCase().trim()),
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
  };
}

function waitForTaskCompletion(params: {
  eventBus: EventBus;
  taskId: string;
  timeoutMs: number;
}): Promise<{ result?: string; error?: string }> {
  const { eventBus, taskId, timeoutMs } = params;
  return new Promise((resolveP, rejectP) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        eventBus.off('agent:task:complete', handler);
        rejectP(new Error(`Ingestion agent timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    function handler(event: RavenEvent): void {
      const payload = (event as AgentTaskCompleteEvent).payload;
      if (payload.taskId !== taskId) return;
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      eventBus.off('agent:task:complete', handler);
      if (payload.success) {
        resolveP({ result: payload.result });
      } else {
        resolveP({ error: payload.errors?.join('; ') ?? 'Agent task failed' });
      }
    }

    eventBus.on('agent:task:complete', handler);
  });
}

interface ExtractedContent {
  content: string;
  sourceFile: string | null;
  sourceUrl: string | null;
}

// Zod refine guarantees: text/voice-memo have content, file has filePath, url has url
function extractContent(input: IngestKnowledge, mediaDir: string): Promise<ExtractedContent> {
  const textContent = input.content ?? '';
  const filePath = input.filePath ?? '';
  const urlValue = input.url ?? '';

  switch (input.type) {
    case 'text':
    case 'voice-memo':
      return Promise.resolve({ content: textContent, sourceFile: null, sourceUrl: null });
    case 'file': {
      const sourceFile = copyToMediaDir({ sourcePath: filePath, mediaDir });
      return extractFromFile(filePath).then((content) => ({
        content,
        sourceFile,
        sourceUrl: null,
      }));
    }
    case 'url':
      return extractFromUrl(urlValue).then((content) => ({
        content,
        sourceFile: null,
        sourceUrl: urlValue,
      }));
  }
}

// eslint-disable-next-line max-lines-per-function -- factory function for ingestion processor
export function createIngestionProcessor(deps: IngestionDeps): IngestionProcessor {
  const { knowledgeStore, eventBus, mediaDir } = deps;

  async function handleIngestionComplete(params: {
    taskId: string;
    input: IngestKnowledge;
    extracted: ExtractedContent;
    source: string;
  }): Promise<void> {
    const { taskId, input, extracted, source } = params;
    try {
      const completion = await waitForTaskCompletion({
        eventBus,
        taskId,
        timeoutMs: INGESTION_TIMEOUT_MS,
      });

      if (completion.error) {
        emitFailedEvent({ taskId, error: completion.error, type: input.type });
        return;
      }

      const parsed = parseIngestionResult(completion.result ?? '');
      const permanence = input.type === 'voice-memo' ? ('temporary' as const) : undefined;
      const bubble = knowledgeStore.insert({
        title: parsed.title,
        content: extracted.content,
        source,
        tags: parsed.tags,
        sourceFile: extracted.sourceFile,
        sourceUrl: extracted.sourceUrl,
        permanence,
      });

      emitCompleteEvent({
        taskId,
        bubbleId: bubble.id,
        title: bubble.title,
        filePath: bubble.filePath,
        sourceFilePath: extracted.sourceFile ?? undefined,
        sourceUrl: extracted.sourceUrl ?? undefined,
      });
      log.info(`Ingestion complete: ${bubble.id} (${bubble.title})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitFailedEvent({ taskId, error: msg, type: input.type });
      log.error(`Ingestion failed for task ${taskId}: ${msg}`);
    }
  }

  function emitFailedEvent(params: {
    taskId: string;
    error: string;
    type: 'text' | 'file' | 'voice-memo' | 'url';
  }): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'ingestion',
      type: 'knowledge:ingest:failed',
      payload: params,
    } as RavenEvent);
  }

  function emitCompleteEvent(params: {
    taskId: string;
    bubbleId: string;
    title: string;
    filePath: string;
    sourceFilePath?: string;
    sourceUrl?: string;
  }): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'ingestion',
      type: 'knowledge:ingest:complete',
      payload: params,
    } as RavenEvent);
  }

  async function ingest(input: IngestKnowledge): Promise<{ taskId: string }> {
    const taskId = generateId();
    const source = deriveSource(input);
    log.info(`Starting ingestion: type=${input.type}, taskId=${taskId}`);

    let extracted: ExtractedContent;
    try {
      extracted = await extractContent(input, mediaDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitFailedEvent({ taskId, error: msg, type: input.type });
      return { taskId };
    }

    const prompt = buildIngestionPrompt({
      content: extracted.content,
      title: input.title,
      tags: input.tags,
      source,
      sourceFile: extracted.sourceFile ?? undefined,
      sourceUrl: extracted.sourceUrl ?? undefined,
    });

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'ingestion',
      type: 'agent:task:request',
      payload: {
        taskId,
        prompt,
        skillName: 'knowledge-ingestion',
        mcpServers: {},
        priority: 'normal',
      },
    } as RavenEvent);

    handleIngestionComplete({ taskId, input, extracted, source });
    return { taskId };
  }

  function start(): void {
    eventBus.on('knowledge:ingest:request', (event: RavenEvent) => {
      const payload = (event as KnowledgeIngestRequestEvent).payload;
      ingest({
        type: payload.type,
        content: payload.content,
        filePath: payload.filePath,
        url: payload.url,
        title: payload.title,
        source: payload.source,
        tags: payload.tags,
      });
    });
    log.info('Ingestion processor started — listening for knowledge:ingest:request events');
  }

  return { ingest, start };
}
