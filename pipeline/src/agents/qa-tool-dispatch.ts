/**
 * QA Tool Dispatch
 *
 * Same pattern as builder, but only registers read-safe tools.
 * The QA_ALLOWED_ROLES config determines which tool categories
 * are permitted — not a hardcoded name list.
 */
import { shellExec } from '../tools/shell.js';
import { fileRead, fileList } from '../tools/files.js';

export type ToolExecutor = (
  input: Record<string, unknown>,
  sandboxPath: string,
) => Promise<string>;

const registry = new Map<string, ToolExecutor>();

/**
 * Tool permission levels.
 * QA only gets 'read' tools by default.
 * Configure QA_TOOL_PERMISSIONS env var to change.
 */
type ToolPermission = 'read' | 'write' | 'execute' | 'deploy';

const toolPermissions = new Map<string, ToolPermission>();

const allowedPermissions: Set<ToolPermission> = new Set(
  (process.env.QA_TOOL_PERMISSIONS ?? 'read')
    .split(',')
    .map((s) => s.trim() as ToolPermission)
);

export function registerTool(name: string, executor: ToolExecutor, permission: ToolPermission): void {
  registry.set(name, executor);
  toolPermissions.set(name, permission);
}

export function isToolAllowed(name: string): boolean {
  const perm = toolPermissions.get(name);
  return perm !== undefined && allowedPermissions.has(perm);
}

export function allowedTools(): string[] {
  return Array.from(registry.keys()).filter(isToolAllowed);
}

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  sandboxPath: string,
): Promise<string> {
  if (!isToolAllowed(name)) {
    return `Tool "${name}" is not permitted in QA (allowed permissions: ${[...allowedPermissions].join(', ')})`;
  }

  const executor = registry.get(name);
  if (!executor) {
    return `Unknown tool: ${name}. Available: ${allowedTools().join(', ')}`;
  }

  try {
    return await executor(input, sandboxPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error (${name}): ${msg}`;
  }
}

// ── Register core QA tools ───────────────────────────────────────────

export function registerCoreQATools(): void {
  registerTool('shell_exec', async (input, sandboxPath) => {
    const { command, timeout_ms } = input as { command: string; timeout_ms?: number };

    // QA shell is read-only: block mutating commands
    const blocked = /\b(rm|mv|cp|chmod|chown|mkdir|rmdir|touch|dd|mkfs|npm\s+install|npm\s+uninstall|git\s+push|git\s+commit|git\s+reset|file_write)\b/i;
    if (blocked.test(command)) {
      return JSON.stringify({
        stdout: '',
        stderr: `QA shell is read-only. Blocked command: ${command.slice(0, 100)}`,
        exitCode: 1,
      });
    }

    const result = await shellExec(command, sandboxPath, timeout_ms);
    return JSON.stringify({
      stdout: result.stdout.slice(0, 8000),
      stderr: result.stderr.slice(0, 2000),
      exitCode: result.exitCode,
    });
  }, 'read');

  registerTool('file_read', async (input, sandboxPath) => {
    const { path } = input as { path: string };
    return fileRead(sandboxPath, path).slice(0, 10000);
  }, 'read');

  registerTool('file_list', async (input, sandboxPath) => {
    const { path = '.' } = input as { path?: string };
    return JSON.stringify(fileList(sandboxPath, path));
  }, 'read');

  console.log(`[qa] Registered ${3} tool executors (allowed: ${[...allowedPermissions].join(', ')})`);
}
