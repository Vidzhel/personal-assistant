import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, generateId } from '@raven/shared';
import type { ConfigCommit, ConfigCommitDetail, RevertResult } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';

const execFile = promisify(execFileCb);
const log = createLogger('config-history');

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const CONFIG_DIR = 'config/';
const GIT_LOG_FORMAT = '%H|%aI|%an|%s';
const SHORT_SHA_LENGTH = 7;

let cachedRoot: string | undefined;
async function getProjectRoot(): Promise<string> {
  if (!cachedRoot) {
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel']);
    cachedRoot = stdout.trim();
  }
  return cachedRoot;
}

function validateHash(hash: string): void {
  if (!SHA_PATTERN.test(hash)) {
    throw new Error(`Invalid git SHA: ${hash}`);
  }
}

function validateFilePath(filePath: string): void {
  if (!filePath.startsWith(CONFIG_DIR)) {
    throw new Error(`File path must start with ${CONFIG_DIR}: ${filePath}`);
  }
  if (filePath.includes('..')) {
    throw new Error(`Path traversal not allowed: ${filePath}`);
  }
}

export async function getConfigCommits(limit: number, offset: number): Promise<ConfigCommit[]> {
  try {
    const cwd = await getProjectRoot();
    const { stdout } = await execFile(
      'git',
      [
        'log',
        `--pretty=format:${GIT_LOG_FORMAT}`,
        `--skip=${offset}`,
        `-${limit}`,
        '--',
        CONFIG_DIR,
      ],
      { cwd },
    );

    if (!stdout.trim()) return [];

    const lines = stdout.trim().split('\n');
    const commits: ConfigCommit[] = [];

    for (const line of lines) {
      const [hash, timestamp, author, ...messageParts] = line.split('|');
      if (!hash || !timestamp || !author) continue;

      const message = messageParts.join('|');

      // Get affected files for this commit
      const { stdout: filesOut } = await execFile(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', hash, '--', CONFIG_DIR],
        { cwd },
      );

      const files = filesOut.trim() ? filesOut.trim().split('\n') : [];

      commits.push({ hash, timestamp, message, author, files });
    }

    return commits;
  } catch (err) {
    log.error(`Failed to get config commits: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function getCommitDetail(hash: string): Promise<ConfigCommitDetail> {
  validateHash(hash);
  const cwd = await getProjectRoot();

  const { stdout: logOut } = await execFile(
    'git',
    ['log', '-1', `--pretty=format:${GIT_LOG_FORMAT}`, hash, '--', CONFIG_DIR],
    { cwd },
  );

  const [commitHash, timestamp, author, ...messageParts] = logOut.trim().split('|');
  if (!commitHash || !timestamp || !author) {
    throw new Error(`Commit not found: ${hash}`);
  }

  const message = messageParts.join('|');

  // Get affected files
  const { stdout: filesOut } = await execFile(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', hash, '--', CONFIG_DIR],
    { cwd },
  );
  const files = filesOut.trim() ? filesOut.trim().split('\n') : [];

  // Get diff for config files
  const { stdout: diffOut } = await execFile('git', ['show', hash, '--', CONFIG_DIR], { cwd });

  // Parse per-file diffs from unified diff output
  const diffs = parseFileDiffs(diffOut, files);

  return {
    hash: commitHash,
    timestamp,
    message,
    author,
    files,
    diffs,
  };
}

function parseFileDiffs(rawDiff: string, files: string[]): Array<{ file: string; diff: string }> {
  const diffs: Array<{ file: string; diff: string }> = [];
  const diffSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of diffSections) {
    const matchedFile = files.find((f) => section.includes(`b/${f}`));
    if (matchedFile) {
      diffs.push({ file: matchedFile, diff: `diff --git ${section}`.trim() });
    }
  }

  // Add empty entries for files with no diff section
  for (const file of files) {
    if (!diffs.some((d) => d.file === file)) {
      diffs.push({ file, diff: '' });
    }
  }

  return diffs;
}

// eslint-disable-next-line max-lines-per-function -- handles both single-file and full-commit revert paths with event emission
export async function revertConfigFile(
  hash: string,
  eventBus: EventBus,
  filePath?: string,
): Promise<RevertResult> {
  const reloadedConfigs: string[] = [];

  try {
    validateHash(hash);
    const cwd = await getProjectRoot();

    if (filePath) {
      validateFilePath(filePath);

      // Resolve absolute path from repo root
      const { join } = await import('node:path');
      const absolutePath = join(cwd, filePath);

      // Restore previous version of specific file
      await execFile('git', ['show', `${hash}~1:${filePath}`], { cwd }).then(
        async ({ stdout: content }) => {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(absolutePath, content);
        },
      );
      await execFile('git', ['add', filePath], { cwd });

      const shortHash = hash.slice(0, SHORT_SHA_LENGTH);
      await execFile('git', ['commit', '-m', `revert: ${filePath} from commit ${shortHash}`], {
        cwd,
      });

      reloadedConfigs.push(filePath);
    } else {
      // Revert entire commit
      await execFile('git', ['revert', '--no-edit', hash], { cwd });

      // Get files that were in the reverted commit
      const { stdout: filesOut } = await execFile(
        'git',
        ['diff-tree', '--no-commit-id', '--name-only', '-r', hash, '--', CONFIG_DIR],
        { cwd },
      );
      reloadedConfigs.push(...(filesOut.trim() ? filesOut.trim().split('\n') : []));
    }

    // Get the new revert commit hash
    const { stdout: headOut } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    const revertHash = headOut.trim();

    // Emit config reload event
    for (const configFile of reloadedConfigs) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'config-history',
        type: 'config:reloaded',
        payload: {
          configType: configFile,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Emit version reverted event
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'config-history',
      type: 'config:version:reverted',
      payload: {
        commitHash: hash,
        revertHash,
        files: reloadedConfigs,
        timestamp: new Date().toISOString(),
      },
    });

    log.info(
      `Config reverted: ${hash.slice(0, SHORT_SHA_LENGTH)} → ${revertHash.slice(0, SHORT_SHA_LENGTH)} (${reloadedConfigs.join(', ')})`,
    );

    return {
      success: true,
      message: `Reverted ${filePath ?? `commit ${hash.slice(0, SHORT_SHA_LENGTH)}`}`,
      revertHash,
      reloadedConfigs,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(`Config revert failed for ${hash.slice(0, SHORT_SHA_LENGTH)}: ${errorMessage}`);
    return {
      success: false,
      message: `Revert failed: ${errorMessage}`,
      reloadedConfigs: [],
    };
  }
}
