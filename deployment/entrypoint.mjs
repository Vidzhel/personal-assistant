import { spawn } from 'node:child_process';
import { initializeRuntime } from './runtime-init.mjs';

try {
  const { root } = initializeRuntime();
  const args =
    process.argv.length > 2 ? process.argv.slice(2) : ['node', 'packages/core/dist/index.js'];
  const command = args.shift();
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(`Raven process could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(`Raven runtime initialization failed: ${error.message}`);
  process.exitCode = 1;
}
