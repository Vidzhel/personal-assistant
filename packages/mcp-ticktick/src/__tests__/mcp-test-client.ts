import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function createTestMcpClient(env: Record<string, string>): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--experimental-strip-types', 'src/index.ts'],
    env: { ...process.env, ...env },
    cwd: PKG_ROOT,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'raven-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}
