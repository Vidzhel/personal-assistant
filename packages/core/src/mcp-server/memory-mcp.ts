import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type {
  SdkMcpToolDefinition,
  McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import type { MemoryStore } from '../agent-memory/memory-store.ts';

type OkResult = { content: [{ type: 'text'; text: string }] };
type ErrResult = { content: [{ type: 'text'; text: string }]; isError: true };

const okResult = (data: unknown): OkResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

const errorResult = (message: string): ErrResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export interface MemoryToolDeps {
  memoryStore: MemoryStore;
  agentName: string;
}

/** Build the three memory tools bound to one agent's directory. */
// eslint-disable-next-line max-lines-per-function, @typescript-eslint/no-explicit-any -- builds three memory management tools; any mirrors buildSystemTools pattern
export function buildMemoryTools(deps: MemoryToolDeps): Array<SdkMcpToolDefinition<any>> {
  const { memoryStore, agentName } = deps;

  const memoryRead = tool(
    'memory_read',
    'Read one of your own memory files. Omit "path" to read your MEMORY.md index.',
    {
      path: z.string().optional().describe('Memory file path relative to your memory dir'),
    },
    async (args) => {
      try {
        const content = args.path
          ? await memoryStore.read(agentName, args.path)
          : ((await memoryStore.readIndex(agentName)) ?? '');
        return okResult({ path: args.path ?? 'MEMORY.md', content });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
    { annotations: { readOnlyHint: true, idempotentHint: true } },
  );

  const memoryWrite = tool(
    'memory_write',
    'Save a new memory file (or overwrite an existing one). Rejected if it would exceed your memory budget.',
    {
      path: z.string().describe('Memory file path relative to your memory dir, e.g. "fact-x.md"'),
      content: z.string().describe('Full file contents'),
    },
    async (args) => {
      try {
        const res = await memoryStore.write(agentName, args.path, args.content);
        return res.ok
          ? okResult(res)
          : errorResult(`${res.error} (usage: ${JSON.stringify(res.usage)})`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  const memoryUpdate = tool(
    'memory_update',
    'Revise an existing memory file. Rejected if the file does not exist or would exceed your budget.',
    {
      path: z.string().describe('Existing memory file path relative to your memory dir'),
      content: z.string().describe('New full file contents'),
    },
    async (args) => {
      try {
        const res = await memoryStore.update(agentName, args.path, args.content);
        return res.ok
          ? okResult(res)
          : errorResult(`${res.error} (usage: ${JSON.stringify(res.usage)})`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  );

  return [memoryRead, memoryWrite, memoryUpdate];
}

/** Build an in-process MCP server exposing the memory tools for one agent. */
export function createMemoryMcp(deps: MemoryToolDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'memory',
    version: '1.0.0',
    tools: buildMemoryTools(deps),
  });
}
