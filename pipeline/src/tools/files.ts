import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from 'fs';
import { join, dirname } from 'path';
import { resolveSandboxPath } from '../agents/sandbox.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
}

export function fileWrite(sandboxPath: string, relativePath: string, content: string): void {
  const abs = resolveSandboxPath(sandboxPath, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

export function fileRead(sandboxPath: string, relativePath: string): string {
  const abs = resolveSandboxPath(sandboxPath, relativePath);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  const size = statSync(abs).size;
  if (size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${size} bytes, max ${MAX_FILE_SIZE}): ${relativePath}`);
  }
  return readFileSync(abs, 'utf-8');
}

export function fileList(sandboxPath: string, relativePath: string = '.'): FileEntry[] {
  const abs = resolveSandboxPath(sandboxPath, relativePath);
  if (!existsSync(abs)) {
    return [];
  }
  const entries = readdirSync(abs);
  return entries.map((name) => {
    const fullPath = join(abs, name);
    const stat = statSync(fullPath);
    const relPath = join(relativePath, name);
    return {
      name,
      path: relPath,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.isFile() ? stat.size : undefined,
    };
  });
}
