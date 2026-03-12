import { spawn } from 'child_process';

(function run() {
  const child = spawn('claude', [
    "-p",
    "can you list ticktick projects",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model",
    "claude-sonnet-4-6",
    "--max-turns",
    "25",
    "--allowedTools",
    "Read,Glob,Grep,WebSearch,WebFetch,mcp__email_gmail__*,mcp__task-management_ticktick__*,Agent",
    "--mcp-config",
    "/home/user/projects/personal-assistant/raven-mcp-cPwMtA/mcp.json"
], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDECODE: undefined },
  });

  child.stdout.on('data', (data: Buffer) => process.stdout.write(data));
  child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
  child.on('close', (code: number | null) => process.exit(code ?? 0));
})()
