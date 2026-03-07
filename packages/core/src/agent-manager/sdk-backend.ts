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
      const msg = message as Record<string, unknown>;

      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id as string;
      }

      if (msg.type === 'assistant') {
        const content = msg.message as {
          content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
        };
        if (content?.content) {
          for (const block of content.content) {
            if (block.type === 'text' && block.text) {
              opts.onAssistantMessage(block.text);
            }
            if (block.type === 'tool_use' && block.name && opts.onToolUse) {
              const inputSummary = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
              opts.onToolUse(block.name, inputSummary);
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
