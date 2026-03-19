import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;

const SAFE_ENV_VARS = ['PATH', 'HOME', 'PWD', 'LANG', 'TERM', 'NODE_ENV', 'TMPDIR'];

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function shellExec(
  command: string,
  sandboxPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ShellResult> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  env.HOME = sandboxPath;
  env.PWD = sandboxPath;

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      cwd: sandboxPath,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message ?? 'Unknown error',
      exitCode: typeof error.code === 'number' ? error.code : 1,
    };
  }
}
