import Anthropic from '@anthropic-ai/sdk';
import { readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { createSandbox } from './sandbox.js';
import { shellExec } from './tools/shell.js';
import { fileWrite, fileRead, fileList } from './tools/files.js';
import { gitInit, gitCommit, githubCreateRepo } from './tools/git.js';
import { browserNavigate, browserScreenshot } from './tools/browser.js';
import { vercelDeploy, netlifyDeploy } from './tools/deploy.js';
import type { TaskBuildRequest, TaskBuildResult, TaskFixRequest, Artifact, ArchitectureDoc, Task, Phase, AvailableTool } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOOL_ITERATIONS = 50;

// ── Build system prompt with dynamic tool docs ───────────────────────

function buildSystemPrompt(architecture: ArchitectureDoc, availableTools: AvailableTool[]): string {
  // Format tool documentation from the registry
  const toolDocs = availableTools.length > 0
    ? availableTools.map((t) => {
        const doc = t.doc;
        const paramList = t.parameters.map((p) =>
          `  - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`
        ).join('\n');
        const examples = doc?.examples?.map((e) => `  ${e}`).join('\n') || '';
        const caveats = doc?.caveats?.map((c) => `  ⚠ ${c}`).join('\n') || '';

        return [
          `- ${t.name}: ${doc?.summary ?? t.description}`,
          paramList ? `  Parameters:\n${paramList}` : '',
          `  Returns: ${t.returnType}`,
          examples ? `  Examples:\n${examples}` : '',
          caveats ? `  Caveats:\n${caveats}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n')
    : '(no tools loaded from registry)';

  return `You are the Builder — a polyglot engineer who lives and breathes code across every stack, language, and paradigm.

You do not design — the Planner already did that. You execute. You take the Planner's task as gospel and implement it with precision, speed, and craftsmanship. You are the kind of engineer who writes code that other engineers read and think "I wish I wrote that."

=== ARCHITECTURE DOCUMENT ===
Overview: ${architecture.overview}
Tech Stack: ${architecture.techStack}
File Structure: ${architecture.fileStructure}
Conventions: ${architecture.conventions}
Notes: ${architecture.notes}
=== END ARCHITECTURE ===

Your principles:
- FOLLOW THE PLAN. The Planner scoped this deliberately. Do not add features, refactor beyond scope, or second-guess architecture decisions. If a task says "create a REST endpoint", do not build a GraphQL layer instead.
- FOLLOW THE ARCHITECTURE. The file structure, naming conventions, and tech stack are decided. Do not deviate. If the architecture says "src/routes/health.ts", create exactly that path.
- WRITE OPTIMIZED CODE. Clean, minimal, fast. No dead code, no commented-out blocks, no TODO placeholders. Use the right data structures. Avoid unnecessary abstractions. Three lines of clear code beats a premature utility function.
- HANDLE ERRORS AT BOUNDARIES. Validate external input (user data, API responses, env vars). Trust internal code. Do not wrap every function call in try-catch — only at system boundaries where failure is expected.
- VERIFY AS YOU GO. After implementing, run it. Install deps then build. Write a file then read it back. Start a server then hit the health endpoint.
- READ BEFORE YOU WRITE. If you need to modify an existing file, read it first. Understand context before changing code.
- INCREMENTAL CONTEXT. You are building one task at a time. Previous tasks in this phase are already complete — their code exists in the sandbox. Read existing files to understand what is already there before adding new code.

=== AVAILABLE TOOLS ===
The following tools are provided by the Kapow tool registry. Use them by name.

${toolDocs}
=== END TOOLS ===

Implement ONLY the assigned task. Commit when the task passes its acceptance criteria.`;
}

// ── Build Claude tool definitions from registry ──────────────────────

/** Core tools that always exist (backed by local implementations) */
const CORE_TOOL_NAMES = new Set([
  'shell_exec', 'file_write', 'file_read', 'file_list',
  'git_commit', 'github_create_repo',
  'vercel_deploy', 'netlify_deploy',
  'browser_navigate', 'browser_screenshot',
]);

function buildClaudeTools(availableTools: AvailableTool[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];

  for (const t of availableTools) {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const p of t.parameters) {
      properties[p.name] = { type: p.type, description: p.description };
      if (p.required) required.push(p.name);
    }

    tools.push({
      name: t.name,
      description: t.doc?.summary ?? t.description,
      input_schema: {
        type: 'object' as const,
        properties,
        required,
      },
    });
  }

  return tools;
}

// ── Fallback: hardcoded tool definitions if registry is unavailable ──

function getDefaultTools(): AvailableTool[] {
  return [
    { id: 'core-shell-exec', name: 'shell_exec', description: 'Execute a shell command in the sandbox working directory', parameters: [{ name: 'command', type: 'string', description: 'Shell command to execute', required: true }, { name: 'timeout_ms', type: 'number', description: 'Optional timeout in milliseconds (default: 120000)', required: false }], returnType: '{ stdout, stderr, exitCode }' },
    { id: 'core-file-write', name: 'file_write', description: 'Write content to a file in the sandbox', parameters: [{ name: 'path', type: 'string', description: 'Relative path within sandbox', required: true }, { name: 'content', type: 'string', description: 'File content', required: true }], returnType: 'void' },
    { id: 'core-file-read', name: 'file_read', description: 'Read a file from the sandbox', parameters: [{ name: 'path', type: 'string', description: 'Relative path within sandbox', required: true }], returnType: 'string' },
    { id: 'core-file-list', name: 'file_list', description: 'List directory contents in the sandbox', parameters: [{ name: 'path', type: 'string', description: 'Relative directory path (default: ".")', required: false }], returnType: 'Array<{ name, path, type, size? }>' },
    { id: 'core-git-commit', name: 'git_commit', description: 'Stage all changes and commit with a message', parameters: [{ name: 'message', type: 'string', description: 'Commit message', required: true }], returnType: 'string' },
    { id: 'core-github-create-repo', name: 'github_create_repo', description: 'Create a new GitHub repository, add it as remote origin, and push', parameters: [{ name: 'repo_name', type: 'string', description: 'Repository name', required: true }, { name: 'description', type: 'string', description: 'Short description', required: true }, { name: 'private', type: 'boolean', description: 'Private repo (default: false)', required: false }], returnType: '{ repoUrl, cloneUrl }' },
    { id: 'core-vercel-deploy', name: 'vercel_deploy', description: 'Deploy to Vercel and return the live URL', parameters: [{ name: 'project_name', type: 'string', description: 'Vercel project name', required: true }, { name: 'build_command', type: 'string', description: 'Optional build command', required: false }, { name: 'output_dir', type: 'string', description: 'Optional output directory', required: false }], returnType: '{ url, deployId }' },
    { id: 'core-netlify-deploy', name: 'netlify_deploy', description: 'Deploy to Netlify and return the live URL', parameters: [{ name: 'site_id', type: 'string', description: 'Existing Netlify site ID', required: false }, { name: 'publish_dir', type: 'string', description: 'Directory to publish (default: ".")', required: false }], returnType: '{ url }' },
    { id: 'core-browser-navigate', name: 'browser_navigate', description: 'Navigate to a URL in the headless browser', parameters: [{ name: 'url', type: 'string', description: 'URL to navigate to', required: true }], returnType: '{ title, content, url }' },
    { id: 'core-browser-screenshot', name: 'browser_screenshot', description: 'Take a screenshot of the current browser page', parameters: [{ name: 'filename', type: 'string', description: 'Output filename (relative to sandbox, .png)', required: true }], returnType: '{ path, size }' },
  ];
}

// ── Tool execution (dispatches to local implementations) ─────────────

async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  sandboxPath: string
): Promise<string> {
  try {
    switch (toolName) {
      case 'shell_exec': {
        const { command, timeout_ms } = toolInput as { command: string; timeout_ms?: number };
        const result = await shellExec(command, sandboxPath, timeout_ms);
        return JSON.stringify({
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 2000),
          exitCode: result.exitCode,
        });
      }
      case 'file_write': {
        const { path, content } = toolInput as { path: string; content: string };
        fileWrite(sandboxPath, path, content);
        return `File written: ${path}`;
      }
      case 'file_read': {
        const { path } = toolInput as { path: string };
        const content = fileRead(sandboxPath, path);
        return content.slice(0, 10000);
      }
      case 'file_list': {
        const { path = '.' } = toolInput as { path?: string };
        const entries = fileList(sandboxPath, path);
        return JSON.stringify(entries);
      }
      case 'git_commit': {
        const { message } = toolInput as { message: string };
        return await gitCommit(sandboxPath, message);
      }
      case 'github_create_repo': {
        const { repo_name, description, private: isPrivate = false } = toolInput as {
          repo_name: string; description: string; private?: boolean;
        };
        return githubCreateRepo(sandboxPath, repo_name, description, isPrivate);
      }
      case 'vercel_deploy': {
        const { project_name, build_command, output_dir } = toolInput as {
          project_name: string; build_command?: string; output_dir?: string;
        };
        return vercelDeploy(sandboxPath, project_name, build_command, output_dir);
      }
      case 'netlify_deploy': {
        const { site_id, publish_dir = '.' } = toolInput as {
          site_id?: string; publish_dir?: string;
        };
        return netlifyDeploy(sandboxPath, site_id, publish_dir);
      }
      case 'browser_navigate': {
        const { url } = toolInput as { url: string };
        return browserNavigate(url);
      }
      case 'browser_screenshot': {
        const { filename } = toolInput as { filename: string };
        return browserScreenshot(sandboxPath, filename);
      }
      default:
        return `Unknown tool: ${toolName}. This tool is registered but has no local implementation. Request it from the technician.`;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error (${toolName}): ${msg}`;
  }
}

const MAX_WALK_DEPTH = 10;
const MAX_ARTIFACTS = 5000;

function collectArtifacts(sandboxPath: string): Artifact[] {
  const artifacts: Artifact[] = [];
  function walk(dir: string, depth: number) {
    if (depth > MAX_WALK_DEPTH || artifacts.length >= MAX_ARTIFACTS) return;
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (artifacts.length >= MAX_ARTIFACTS) return;
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(dir, entry);
      const rel = relative(sandboxPath, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        artifacts.push({ path: rel, type: 'directory' });
        walk(full, depth + 1);
      } else {
        artifacts.push({ path: rel, type: 'file' });
      }
    }
  }
  walk(sandboxPath, 0);
  return artifacts;
}

function formatTaskContext(task: Task, phase: Phase, constraints: string[], completedTasks: string[]): string {
  return [
    `Phase: ${phase.name} — ${phase.description}`,
    '',
    `Task: [${task.id}] (${task.type}) ${task.description}`,
    '  Acceptance Criteria:',
    ...task.acceptanceCriteria.map((c) => `    - ${c}`),
    '',
    'Constraints:',
    ...constraints.map((c) => `- ${c}`),
    '',
    completedTasks.length > 0
      ? `Previously completed tasks in this phase: ${completedTasks.join(', ')}. Their code is already in the sandbox — read existing files before adding new ones.`
      : 'This is the first task. The sandbox is empty.',
  ].join('\n');
}

async function runAgentLoop(
  systemPrompt: string,
  userContent: string,
  sandboxPath: string,
  logs: string[],
  claudeTools: Anthropic.Tool[]
): Promise<boolean> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];
  let iterations = 0;

  while (true) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      logs.push(`WARNING: Max tool iterations (${MAX_TOOL_ITERATIONS}) reached.`);
      return false;
    }
    iterations++;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      tools: claudeTools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        logs.push(block.text.trim().slice(0, 500));
      }
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          logs.push(`Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
          const result = await handleToolCall(
            block.name,
            block.input as Record<string, unknown>,
            sandboxPath
          );
          logs.push(`  Result: ${result.slice(0, 200)}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      logs.push('Builder completed.');
      return true;
    }
  }
}

export async function buildTask(req: TaskBuildRequest): Promise<TaskBuildResult> {
  const sandboxPath = req.sandboxPath ?? createSandbox(req.runId);
  const logs: string[] = [];

  if (!req.sandboxPath) {
    await gitInit(sandboxPath);
    logs.push(`Sandbox created at ${sandboxPath}`);
  }

  // Use tools from the registry if provided, otherwise fall back to defaults
  const availableTools = req.availableTools && req.availableTools.length > 0
    ? req.availableTools
    : getDefaultTools();

  logs.push(`Tools available: ${availableTools.map((t) => t.name).join(', ')}`);

  const systemPrompt = buildSystemPrompt(req.architecture, availableTools);
  const claudeTools = buildClaudeTools(availableTools);

  const userContent = [
    `Run ID: ${req.runId}`,
    '',
    formatTaskContext(req.task, req.phase, req.constraints, req.completedTasks),
  ].join('\n');

  const success = await runAgentLoop(systemPrompt, userContent, sandboxPath, logs, claudeTools);
  const artifacts = collectArtifacts(sandboxPath);

  return {
    runId: req.runId,
    taskId: req.task.id,
    sandboxPath,
    artifacts,
    logs,
    success,
  };
}

export async function fixTask(req: TaskFixRequest): Promise<TaskBuildResult> {
  const sandboxPath = req.previousBuildResult.sandboxPath;
  const logs: string[] = [`Fix iteration ${req.iteration} started for task ${req.task.id}`];

  // Use same tools as the original build
  const availableTools = getDefaultTools();
  const systemPrompt = buildSystemPrompt(req.architecture, availableTools);
  const claudeTools = buildClaudeTools(availableTools);

  const userContent = [
    `Run ID: ${req.runId} (fix iteration ${req.iteration})`,
    '',
    `Task: [${req.task.id}] (${req.task.type}) ${req.task.description}`,
    '  Acceptance Criteria:',
    ...req.task.acceptanceCriteria.map((c) => `    - ${c}`),
    '',
    'The previous implementation of this task did not pass QA. Here is what needs to be fixed:',
    '',
    req.delta,
    '',
    'The sandbox still has your previous work. Make targeted fixes only.',
    'After fixing, commit the changes.',
  ].join('\n');

  const success = await runAgentLoop(systemPrompt, userContent, sandboxPath, logs, claudeTools);
  const artifacts = collectArtifacts(sandboxPath);

  return {
    runId: req.runId,
    taskId: req.task.id,
    sandboxPath,
    artifacts,
    logs: [...req.previousBuildResult.logs, ...logs],
    success,
  };
}
