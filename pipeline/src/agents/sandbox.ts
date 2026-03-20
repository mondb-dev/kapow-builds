import { mkdirSync, rmSync, existsSync, realpathSync, lstatSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';

const BASE_DIR = process.env.SANDBOX_BASE ?? '/tmp/kapow';

export function createSandbox(runId: string): string {
  const sandboxPath = join(BASE_DIR, runId);
  mkdirSync(sandboxPath, { recursive: true });
  return sandboxPath;
}

export function cleanupSandbox(runId: string): void {
  const sandboxPath = join(BASE_DIR, runId);
  if (existsSync(sandboxPath)) {
    rmSync(sandboxPath, { recursive: true, force: true });
  }
}

export function getSandboxPath(runId: string): string {
  return join(BASE_DIR, runId);
}

/**
 * Resolves a path relative to the sandbox, preventing path traversal and symlink escapes.
 * Throws if the resolved path escapes the sandbox directory.
 */
export function resolveSandboxPath(sandboxPath: string, relativePath: string): string {
  // Use realpathSync for base to resolve any symlinks in the sandbox path itself
  const base = realpathSync(sandboxPath);

  // Resolve the target path (file may not exist yet)
  const abs = resolve(join(base, relativePath));

  // Check that the resolved path is within the sandbox
  if (!abs.startsWith(base + '/') && abs !== base) {
    throw new Error(`Path traversal attempt blocked: ${relativePath}`);
  }

  // Check each existing parent component for symlinks
  let current = abs;
  while (current !== base && current !== dirname(current)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink in path blocked: ${relativePath}`);
      }
    }
    current = dirname(current);
  }

  return abs;
}
