import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, BackendOptions, BackendResult } from './agent-backend.ts';

export function createSdkBackend(): AgentBackend {
  return async (opts: BackendOptions): Promise<BackendResult> => {
    let sessionId: string | undefined;
    let resultText = '';
    let success = false;
    const errors: string[] = [];

    const queryOptions: Record<string, unknown> = {
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      permissionMode: 'bypassPermissions' as const,
      model: opts.model,
      maxTurns: opts.maxTurns,
      stderr: opts.onStderr,
      cwd: opts.cwd,
    };

    if (Object.keys(opts.mcpServers).length > 0) {
      queryOptions.mcpServers = opts.mcpServers;
    }

    if (Object.keys(opts.agents).length > 0) {
      queryOptions.agents = opts.agents;
    }

    for await (const message of query({
      prompt: opts.prompt,
      options: queryOptions as Parameters<typeof query>[0]['options'],
    })) {
      if (opts.signal?.aborted) {
        errors.push('cancelled');
        break;
      }
      const msg = message as Record<string, unknown>;
      opts.onRawMessage?.(JSON.stringify(msg));

      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id as string;
      }

      if (msg.type === 'assistant') {
        const parentToolUseId = (msg.parent_tool_use_id as string | null) ?? null;
        const content = msg.message as {
          content?: Array<{
            type: string;
            text?: string;
            name?: string;
            input?: unknown;
            id?: string;
          }>;
        };
        if (content?.content) {
          for (const block of content.content) {
            if (block.type === 'text' && block.text) {
              opts.onAssistantMessage(block.text, { parentToolUseId });
            }
            if (block.type === 'tool_use' && block.name && opts.onToolUse) {
              const inputSummary = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
              opts.onToolUse(block.name, inputSummary, {
                parentToolUseId,
                toolUseId: block.id,
              });
            }
          }
        }
      }

      if (msg.type === 'user') {
        const parentToolUseId = (msg.parent_tool_use_id as string | null) ?? null;
        const content = msg.message as {
          content?: Array<{
            type: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          }>;
        };
        if (content?.content && opts.onToolResult) {
          for (const block of content.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const output =
                typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content ?? '').slice(0, 500);
              opts.onToolResult({
                toolUseId: block.tool_use_id,
                output,
                isError: block.is_error ?? false,
                meta: { parentToolUseId },
              });
            }
          }
        }
      }

      if (msg.type === 'result') {
        success = msg.subtype === 'success';
        resultText = (msg.result as string) ?? '';
        if (!success) {
          errors.push(`Agent ended with status: ${msg.subtype}`);
        }
      }
    }

    return { sessionId, result: resultText, success, errors };
  };
}
