import { appendFileSync, readSync, writeSync } from 'node:fs';

const logPath = process.env.FAKE_MODEL_DISCOVERY_LOG;
const lifecycleLogPath = process.env.FAKE_MODEL_DISCOVERY_LIFECYCLE_LOG;
const buffer = Buffer.alloc(4_096);
let pending = '';

recordLifecycle('started');

while (true) {
  const bytesRead = readSync(0, buffer);
  if (bytesRead === 0) break;
  pending += buffer.subarray(0, bytesRead).toString('utf8');
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    if (line) handleMessage(JSON.parse(line));
  }
}
recordLifecycle('stdin:eof');

function handleMessage(message) {
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({ type: message.type, subtype: message.request?.subtype })}\n`,
    );
  }
  if (process.env.FAKE_MODEL_DISCOVERY_MODE === 'hang') return;
  if (message.type !== 'control_request') return;
  writeSync(
    1,
    `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {
          models: [
            {
              value: 'sonnet',
              resolvedModel: 'claude-sonnet-5',
              displayName: 'Sonnet Fixture',
              description: 'Fixture only',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'high'],
              supportsAdaptiveThinking: true,
            },
          ],
          commands: [],
        },
      },
    })}\n`,
  );
}

function recordLifecycle(type) {
  if (lifecycleLogPath) {
    appendFileSync(lifecycleLogPath, `${JSON.stringify({ type, pid: process.pid })}\n`);
  }
}
