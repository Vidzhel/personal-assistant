import { execFile as execFileCb } from 'node:child_process';
import { createLogger } from './logger.ts';

const log = createLogger('git-commit');

export function gitAutoCommit(filePaths: string[], message: string): Promise<void> {
  return new Promise((resolve) => {
    execFileCb('git', ['add', ...filePaths], (addErr) => {
      if (addErr) {
        log.warn(`Git auto-commit failed (non-blocking): ${addErr.message}`);
        resolve();
        return;
      }
      execFileCb('git', ['commit', '-m', message], (commitErr) => {
        if (commitErr) {
          log.warn(`Git auto-commit failed (non-blocking): ${commitErr.message}`);
        }
        resolve();
      });
    });
  });
}
