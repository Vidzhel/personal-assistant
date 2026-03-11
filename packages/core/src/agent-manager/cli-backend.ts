import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@raven/shared';
import type { AgentBackend, BackendOptions, BackendResult } from './agent-backend.ts';

const log = createLogger('cli-backend');

export function createCliBackend(): AgentBackend {
  return async (opts: BackendOptions): Promise<BackendResult> => {
    let tmpMcpDir: string | undefined;

    try {
      const args = [
        '-p',
        opts.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--model',
        opts.model,
        '--max-turns',
        String(opts.maxTurns),
        '--system-prompt',
        opts.systemPrompt,
        '--allowedTools',
        opts.allowedTools.join(','),
      ];

      // MCP config temp file
      if (Object.keys(opts.mcpServers).length > 0) {
        tmpMcpDir = await mkdtemp(join(tmpdir(), 'raven-mcp-'));
        const mcpConfigPath = join(tmpMcpDir, 'mcp.json');
        await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: opts.mcpServers }));
        args.push('--mcp-config', mcpConfigPath);
      }

      // Sub-agent definitions
      if (Object.keys(opts.agents).length > 0) {
        args.push('--agents', JSON.stringify(opts.agents));
      }

      return await spawnClaude(args, opts);
    } finally {
      if (tmpMcpDir) {
        await rm(tmpMcpDir, { recursive: true }).catch((err: unknown) => {
          log.warn(`Failed to clean up MCP temp dir: ${tmpMcpDir}: ${err}`);
        });
      }
    }
  };
}

function spawnClaude(args: string[], opts: BackendOptions): Promise<BackendResult> {
  return new Promise((resolve, reject) => {
    let sessionId: string | undefined;
    let resultText = '';
    let success = false;
    const errors: string[] = [];
    let buffer = '';

    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    child.stderr.on('data', (chunk: Buffer) => {
      opts.onStderr(chunk.toString());
    });

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;

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
        } catch {
          log.debug(`Failed to parse line from claude output as JSON: ${trimmed}`);
        }
      }
    });

    child.on('error', (err: Error) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    child.on('close', (code: number | null) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim()) as Record<string, unknown>;
          if (msg.type === 'result') {
            success = msg.subtype === 'success';
            resultText = (msg.result as string) ?? '';
            if (!success) {
              errors.push(`Agent ended with status: ${msg.subtype}`);
            }
          }
        } catch (err) {
          log.debug(
            `Failed to parse line from claude output as JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (code !== 0 && !success) {
        errors.push(`claude CLI exited with code ${code}`);
        success = false;
      }

      resolve({ sessionId, result: resultText, success, errors });
    });
  });
}
