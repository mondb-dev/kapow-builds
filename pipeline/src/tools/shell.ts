import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ShellResult } from 'kapow-shared';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per command

const SAFE_ENV_VARS = [
  'PATH', 'HOME', 'PWD', 'LANG', 'TERM', 'NODE_ENV', 'TMPDIR',
  'VERCEL_TOKEN', 'VERCEL_SCOPE', 'NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID',
  'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
];

export async function shellExec(
  command: string,
  sandboxPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  extraEnv?: Record<string, string>
): Promise<ShellResult> {
  // Build whitelisted env
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  // Override HOME and PWD to sandbox
  env.HOME = sandboxPath;
  env.PWD = sandboxPath;

  // Merge any extra env vars (e.g. deploy tokens)
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
      cwd: sandboxPath,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
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
