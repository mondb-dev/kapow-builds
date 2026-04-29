/**
 * Dynamic Tool Dispatch
 *
 * Core tools (file, shell, git, browser, deploy) are registered on boot.
 * When the builder needs an unknown tool, we ask the technician to find
 * or create it, then hot-register its executor for future use.
 */
import axios from 'axios';
import { redactSecrets } from '../tools/redact.js';

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

/**
 * Dynamic tools execute arbitrary code from the technician service via `new Function`.
 * Refused by default: if technician is compromised it would mean RCE in the pipeline
 * with full Node.js + filesystem + network access. Opt in only for trusted local dev
 * by setting ALLOW_DYNAMIC_TOOLS=true.
 */
const ALLOW_DYNAMIC_TOOLS = process.env.ALLOW_DYNAMIC_TOOLS === 'true';

function registerDynamicTool(name: string, implementation: string): void {
  if (!ALLOW_DYNAMIC_TOOLS) {
    registerTool(name, async () =>
      `Dynamic tool "${name}" refused: arbitrary code execution from technician is disabled. ` +
      `Set ALLOW_DYNAMIC_TOOLS=true only in trusted local environments.`
    );
    console.warn(`[tool-dispatch] refused dynamic tool "${name}" (ALLOW_DYNAMIC_TOOLS not set)`);
    return;
  }

  registerTool(name, async (input, sandboxPath) => {
    try {
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

let onRepoCreatedHook: ((repoUrl: string) => void) | undefined;
export function setOnRepoCreated(fn: (repoUrl: string) => void): void {
  onRepoCreatedHook = fn;
}
export function getOnRepoCreated(): ((repoUrl: string) => void) | undefined {
  return onRepoCreatedHook;
}

/**
 * Helpers used by core tool registrations to validate LLM-supplied input.
 * The model occasionally passes wrong types (e.g. number for `command`);
 * fail loudly instead of silently coercing.
 */
export function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string') throw new Error(`Tool input "${key}" must be a string, got ${typeof v}`);
  return v;
}
export function requireNumber(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Tool input "${key}" must be a finite number, got ${typeof v}`);
  return v;
}
export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`Tool input "${key}" must be a string if provided, got ${typeof v}`);
  return v;
}

/** Execute a tool by name. If unknown, ask the technician first. */
export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  sandboxPath: string,
): Promise<string> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return `Tool error (${name}): input must be a JSON object, got ${Array.isArray(input) ? 'array' : typeof input}`;
  }
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
    const result = await executor(input, sandboxPath);
    return redactSecrets(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error (${name}): ${redactSecrets(msg)}`;
  }
}
