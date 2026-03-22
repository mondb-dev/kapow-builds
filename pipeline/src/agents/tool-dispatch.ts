/**
 * Dynamic Tool Dispatch
 *
 * Core tools (file, shell, git, browser, deploy) are registered on boot.
 * When the builder needs an unknown tool, we ask the technician to find
 * or create it, then hot-register its executor for future use.
 */
import axios from 'axios';

export type ToolExecutor = (
  input: Record<string, unknown>,
  sandboxPath: string,
) => Promise<string>;

const registry = new Map<string, ToolExecutor>();
const TECHNICIAN_URL = process.env.TECHNICIAN_URL ?? 'http://localhost:3006';

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

/**
 * Request a tool from the technician. If found or created,
 * hot-register a shell-based executor and return the tool info.
 */
async function requestToolFromTechnician(
  name: string,
  runId: string,
): Promise<{ found: boolean; message: string }> {
  try {
    const res = await axios.post(`${TECHNICIAN_URL}/request-tool`, {
      runId,
      need: `Tool "${name}" was called but does not exist locally. The builder needs this capability to complete its task.`,
      requestingAgent: 'builder',
      context: `The builder attempted to use a tool called "${name}" but it is not registered. Available tools: ${registeredTools().join(', ')}`,
    }, { timeout: 60_000 });

    const outcome = res.data?.outcome;
    if (!outcome) return { found: false, message: 'Technician returned no outcome' };

    if (outcome.action === 'found_existing' || outcome.action === 'created_new' || outcome.action === 'updated_existing') {
      const tool = outcome.tool;
      if (tool?.implementation && tool?.name) {
        // Hot-register a dynamic executor that evals the implementation
        registerDynamicTool(tool.name, tool.implementation);
        return { found: true, message: `Technician provided tool "${tool.name}": ${tool.description}` };
      }
      return { found: false, message: `Technician found tool but no executable implementation` };
    }

    return { found: false, message: outcome.error ?? `Technician action: ${outcome.action}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { found: false, message: `Technician request failed: ${msg}` };
  }
}

/** Register a dynamic tool from its implementation code string */
function registerDynamicTool(name: string, implementation: string): void {
  registerTool(name, async (input, sandboxPath) => {
    try {
      // Dynamic tools are Node.js functions — create and execute them
      const fn = new Function('input', 'sandboxPath', 'require', implementation);
      const result = await fn(input, sandboxPath, require);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Dynamic tool error (${name}): ${msg}`;
    }
  });
}

// Track current runId for technician requests
let currentRunId = 'unknown';
export function setCurrentRunId(runId: string): void {
  currentRunId = runId;
}

/** Execute a tool by name. If unknown, ask the technician first. */
export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  sandboxPath: string,
): Promise<string> {
  let executor = registry.get(name);

  // If tool is unknown, ask the technician
  if (!executor) {
    const result = await requestToolFromTechnician(name, currentRunId);
    if (result.found) {
      executor = registry.get(name);
    }
    if (!executor) {
      return `Unknown tool: ${name}. ${result.message}. Available tools: ${registeredTools().join(', ')}`;
    }
  }

  try {
    return await executor(input, sandboxPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error (${name}): ${msg}`;
  }
}
