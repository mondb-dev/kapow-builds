import { existsSync, realpathSync, lstatSync } from 'fs';
import { join, resolve, dirname } from 'path';

/**
 * Resolves a path relative to the sandbox, preventing path traversal and symlink escapes.
 */
export function resolveSandboxPath(sandboxPath: string, relativePath: string): string {
  const base = realpathSync(sandboxPath);
  const abs = resolve(join(base, relativePath));

  if (!abs.startsWith(base + '/') && abs !== base) {
    throw new Error(`Path traversal attempt blocked: ${relativePath}`);
  }

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
