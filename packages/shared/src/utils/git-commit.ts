import { execFile as execFileCb } from 'node:child_process';
import { createLogger } from './logger.ts';

const log = createLogger('git-commit');

/**
 * Stages and commits exactly the given paths. The commit uses a trailing
 * `-- <paths...>` pathspec (not a bare `git commit`) so it captures only
 * these paths even if something else happens to be staged in the working
 * tree — callers never accidentally sweep in unrelated changes.
 */
export function gitAutoCommit(filePaths: string[], message: string, cwd?: string): Promise<void> {
  return new Promise((resolve) => {
    const runGit = (args: string[], cb: (err: Error | null) => void): void => {
      if (cwd) {
        execFileCb('git', args, { cwd }, (err) => cb(err));
      } else {
        execFileCb('git', args, (err) => cb(err));
      }
    };

    runGit(['add', ...filePaths], (addErr) => {
      if (addErr) {
        log.warn(`Git auto-commit failed (non-blocking): ${addErr.message}`);
        resolve();
        return;
      }
      runGit(['commit', '-m', message, '--', ...filePaths], (commitErr) => {
        if (commitErr) {
          log.warn(`Git auto-commit failed (non-blocking): ${commitErr.message}`);
        }
        resolve();
      });
    });
  });
}
