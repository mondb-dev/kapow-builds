/**
 * Dynamic Tool Dispatch
 *
 * Replaces the hardcoded switch statement in builder.ts.
 * Tools register themselves at startup. When the technician
 * creates a new tool, its executor can be hot-registered here.
 *
 * Core tools (file, shell, git, browser, deploy) are registered
 * on boot. Dynamic tools from the registry can register executors
 * at runtime via registerTool().
 */

export type ToolExecutor = (
  input: Record<string, unknown>,
  sandboxPath: string,
) => Promise<string>;

const registry = new Map<string, ToolExecutor>();

/** Register a tool executor by name */
export function registerTool(name: string, executor: ToolExecutor): void {
  registry.set(name, executor);
}

/** Check if a tool has a local executor */
export function hasTool(name: string): boolean {
  return registry.has(name);
}

/** List all registered tool names */
export function registeredTools(): string[] {
  return Array.from(registry.keys());
}

/** Execute a tool by name. Returns result string or error message. */
export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  sandboxPath: string,
): Promise<string> {
  const executor = registry.get(name);
  if (!executor) {
    return `Unknown tool: ${name}. Available tools: ${registeredTools().join(', ')}. If this tool was recently created by the technician, its executor may not be registered yet.`;
  }

  try {
    return await executor(input, sandboxPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error (${name}): ${msg}`;
  }
}
