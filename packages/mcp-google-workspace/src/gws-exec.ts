import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT = 30_000;

export interface GwsResult {
  data: unknown;
  stderr: string;
}

interface GwsExecOptions {
  credentialsFile?: string;
  timeout?: number;
}

function execFilePromise(
  cmd: string,
  args: string[],
  options: { env: Record<string, string>; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        const errWithStreams = error as Error & { stdout?: string; stderr?: string };
        errWithStreams.stderr = stderr;
        errWithStreams.stdout = stdout;
        reject(errWithStreams);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function gwsExec(args: string[], opts?: GwsExecOptions): Promise<GwsResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts?.credentialsFile) {
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = opts.credentialsFile;
  }

  try {
    const { stdout, stderr } = await execFilePromise('gws', args, {
      env,
      timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
    });

    const data: unknown = stdout.trim() ? (JSON.parse(stdout) as unknown) : null;
    return { data, stderr };
  } catch (err: unknown) {
    const error = err as { stderr?: string; code?: string; message?: string };
    const message = error.stderr?.trim() || error.message || 'Unknown gws error';
    throw new Error(`gws command failed: ${message}`, { cause: err });
  }
}
