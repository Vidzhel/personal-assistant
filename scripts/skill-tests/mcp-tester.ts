import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpTestResult {
  tools: string[];
  error?: string;
}

export interface McpToolCallResult {
  content: unknown;
  error?: string;
}

export interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: string[];
}

export async function testMcpConnection(
  config: { command: string; args: string[]; env?: Record<string, string>; cwd?: string },
  timeoutMs = 15_000,
): Promise<McpTestResult> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
    cwd: config.cwd ?? process.cwd(),
    stderr: 'pipe',
  });

  const client = new Client({ name: 'raven-skill-test', version: '1.0.0' });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`MCP connection timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  try {
    await Promise.race([client.connect(transport), timeout]);
    const result = await Promise.race([client.listTools(), timeout]);
    const tools = result.tools.map((t) => t.name);
    return { tools };
  } catch (err) {
    return { tools: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await transport.close();
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function connectMcp(
  config: { command: string; args: string[]; env?: Record<string, string>; cwd?: string },
  timeoutMs = 15_000,
): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
    cwd: config.cwd ?? process.cwd(),
    stderr: 'pipe',
  });

  const client = new Client({ name: 'raven-skill-test', version: '1.0.0' });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`MCP connection timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  await Promise.race([client.connect(transport), timeout]);
  const result = await Promise.race([client.listTools(), timeout]);
  const tools = result.tools.map((t) => t.name);
  return { client, transport, tools };
}

export async function callMcpTool(
  connection: McpConnection,
  toolName: string,
  args: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<McpToolCallResult> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  try {
    const result = await Promise.race([
      connection.client.callTool({ name: toolName, arguments: args }),
      timeout,
    ]);
    return { content: result.content };
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function closeMcp(connection: McpConnection): Promise<void> {
  try {
    await connection.transport.close();
  } catch {
    // ignore cleanup errors
  }
}
