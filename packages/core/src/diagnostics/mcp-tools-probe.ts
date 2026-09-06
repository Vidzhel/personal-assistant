import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HTTP_STATUS } from '@raven/shared';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_PAGES = 4;
const MAX_TOOLS = 200;
const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_FAILURE = 'The MCP connection or tool catalog could not be verified.';

export interface McpToolsProbeInput {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type McpToolsProbeResult =
  | { state: 'verified'; toolNames: string[] }
  | { state: 'failed'; reason: string; stage: 'authentication' | 'connection' | 'tools' };

interface ProbeContext {
  controller: AbortController;
  failure: string;
  totalBytes: number;
  timeoutMs: number;
  stage: 'authentication' | 'connection' | 'tools';
}

function boundedBody(response: Response, context: ProbeContext): Response {
  if (!response.body) return response;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, stream) {
        context.totalBytes += chunk.byteLength;
        if (context.totalBytes > MAX_RESPONSE_BYTES) {
          context.failure = 'The MCP response exceeded the readiness size limit.';
          context.controller.abort();
          stream.error(new Error('MCP readiness size limit'));
          return;
        }
        stream.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function boundedFetch(context: ProbeContext): typeof fetch {
  return async (url, init) => {
    const signal = AbortSignal.any(
      [context.controller.signal, init?.signal].filter((item): item is AbortSignal =>
        Boolean(item),
      ),
    );
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN) {
      context.stage = 'authentication';
      context.failure = 'The MCP server rejected authentication. Replace its API token and retry.';
    }
    return boundedBody(response, context);
  };
}

async function listCatalog(
  client: Client,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<McpToolsProbeResult> {
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    });
    for (const tool of result.tools) {
      if (names.has(tool.name) || names.size >= MAX_TOOLS) {
        return {
          state: 'failed',
          stage: 'tools',
          reason: 'The MCP tool catalog is duplicated or exceeds the readiness limit.',
        };
      }
      names.add(tool.name);
    }
    if (!result.nextCursor) return { state: 'verified', toolNames: [...names] };
    if (cursors.has(result.nextCursor)) break;
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return {
    state: 'failed',
    stage: 'tools',
    reason: 'The MCP tool catalog is incomplete within the readiness page limit.',
  };
}

async function connectAndList(
  input: McpToolsProbeInput,
  context: ProbeContext,
  client: Client,
): Promise<McpToolsProbeResult> {
  const timeoutMs = context.timeoutMs;
  const endpoint = new URL(input.url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    return {
      state: 'failed',
      stage: 'connection',
      reason: 'The MCP endpoint must be an HTTP URL without credentials.',
    };
  }
  context.controller.signal.throwIfAborted();
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: input.headers },
    fetch: boundedFetch(context),
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  await client.connect(transport, {
    signal: context.controller.signal,
    timeout: timeoutMs,
    maxTotalTimeout: timeoutMs,
  });
  context.stage = 'tools';
  return listCatalog(client, context.controller.signal, timeoutMs);
}

// Only fixed diagnostic text leaves this boundary: provider bodies and exception messages
// can contain authorization headers, URLs, or account data.
export async function probeMcpTools(input: McpToolsProbeInput): Promise<McpToolsProbeResult> {
  const context: ProbeContext = {
    controller: new AbortController(),
    failure: DEFAULT_FAILURE,
    totalBytes: 0,
    stage: 'connection',
    timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
  const timeoutMs = context.timeoutMs;
  const abort = (): void => context.controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const client = new Client({ name: 'raven-readiness', version: '1.0.0' });
  try {
    return await connectAndList(input, context, client);
  } catch {
    return {
      state: 'failed',
      stage: context.stage,
      reason:
        context.controller.signal.aborted && context.failure === DEFAULT_FAILURE
          ? 'The MCP readiness check was cancelled or exceeded its time limit.'
          : context.failure,
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    context.controller.abort();
    await client.close().catch(() => undefined);
  }
}
