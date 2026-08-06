import { createLogger } from '@raven/shared';
import { loadConfig } from './config.ts';
import { createRaven } from './raven.ts';

const log = createLogger('raven');

async function main(): Promise<void> {
  const config = loadConfig();
  const raven = await createRaven(config);
  await raven.start();

  const shutdown = async (): Promise<void> => {
    await raven.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Prevent unhandled rejections from crashing the server
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});

main().catch((err) => {
  // eslint-disable-next-line no-console -- fatal handler, logger may not be initialized
  console.error('Fatal error:', err);
  process.exit(1);
});
