import { getAI } from 'kapow-shared';
import type { AIToolDef, AIMessage, AIContentBlock } from 'kapow-shared';
import { readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { createSandbox } from './sandbox.js';
import { gitInit } from '../tools/git.js';
import { dispatchTool, registeredTools, setCurrentRunId } from './tool-dispatch.js';
import { registerCoreTools } from './tool-registration.js';
import type { TaskBuildRequest, TaskBuildResult, TaskFixRequest, Artifact, ArchitectureDoc, Task, Phase, AvailableTool } from 'kapow-shared';

// Register core tools on module load
registerCoreTools();

const { provider, models } = getAI();

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

  return `You are the Builder. You produce exactly what was asked for — nothing more.

=== CRITICAL: CHOOSE THE RIGHT APPROACH ===

Before doing ANYTHING, classify the task:

**DIRECT OUTPUT** — The task asks you to create/generate content (a document, text file, image, PDF, data file, poem, story, config, etc.)
→ Just use file_write to create the output file directly. Do NOT set up a project, install packages, or write generator scripts.
→ Example: "Create a PDF with a poem" → write the poem content to a file. Do NOT install pdf-lib, express, or any framework.
→ Example: "Write a hello world HTML page" → file_write a single index.html with inline CSS/JS. Do NOT set up webpack, npm, or a build system.
→ Example: "Generate a CSV of sample data" → file_write the CSV content directly.

**SIMPLE PROJECT** — The task asks for a small app/script (1-3 files, minimal deps)
→ Create files directly. Only use shell_exec for npm init/install if you genuinely need runtime dependencies.
→ Prefer zero-dependency solutions. Vanilla JS/HTML/CSS over frameworks when possible.

**FULL PROJECT** — The task explicitly asks for a framework-based app, server, or multi-file system
→ Only then: set up project structure, install dependencies, configure build tools.

THE GOLDEN RULE: Use the SIMPLEST approach that satisfies the acceptance criteria. If you can do it with file_write alone, do it with file_write alone.

=== ARCHITECTURE DOCUMENT ===
Overview: ${architecture.overview}
Tech Stack: ${architecture.techStack}
File Structure: ${architecture.fileStructure}
Conventions: ${architecture.conventions}
Notes: ${architecture.notes}
=== END ARCHITECTURE ===

Your principles:
- SIMPLEST SOLUTION FIRST. If a task can be done with one file_write call, do that. Do not over-engineer.
- FOLLOW THE PLAN. Do not add features, frameworks, or infrastructure beyond what was asked.
- READ BEFORE YOU WRITE. If modifying existing files, read them first.
- VERIFY YOUR WORK. After creating files, read them back or run them to confirm they work.

=== AVAILABLE TOOLS ===
${toolDocs}
=== END TOOLS ===

If you need a tool that isn't listed above (e.g. git, deploy, browser), use discover_tools to activate it first.

Implement ONLY the assigned task. Use the minimum number of tool calls needed.`;
}

// ── Build Claude tool definitions from registry ──────────────────────

/** Tool sets by task type — start minimal, discover more if needed */
const TOOLS_BY_TYPE: Record<string, Set<string>> = {
  file:    new Set(['file_write', 'file_read', 'file_list']),
  shell:   new Set(['file_write', 'file_read', 'file_list', 'shell_exec']),
  code:    new Set(['file_write', 'file_read', 'file_list', 'shell_exec', 'git_commit']),
  api:     new Set(['file_write', 'file_read', 'file_list', 'shell_exec', 'git_commit']),
  browser: new Set(['file_write', 'file_read', 'file_list', 'shell_exec', 'browser_navigate', 'browser_screenshot']),
};

/** All possible tool names for discovery */
const ALL_TOOL_NAMES = new Set([
  'shell_exec', 'file_write', 'file_read', 'file_list',
  'git_commit', 'github_create_repo',
  'vercel_deploy', 'netlify_deploy',
  'browser_navigate', 'browser_screenshot',
]);

function buildClaudeTools(availableTools: AvailableTool[]): AIToolDef[] {
  const tools: AIToolDef[] = [];

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

// ── Tool execution (dynamic dispatch via registry) ───────────────────

async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  sandboxPath: string
): Promise<string> {
  return dispatchTool(toolName, toolInput, sandboxPath);
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
    ...(constraints.length > 0 ? [
      'Constraints:',
      ...constraints.map((c) => `- ${c}`),
      '',
    ] : []),
    completedTasks.length > 0
      ? [
          `Previously completed tasks: ${completedTasks.join(', ')}`,
          'Their code is already in the sandbox. IMPORTANT: Start by running file_list to see what exists, then read key files before writing new code. Build on what is already there — do not duplicate or overwrite existing work.',
        ].join('\n')
      : 'This is the first task. The sandbox is empty. Start by setting up the project structure.',
  ].join('\n');
}

async function runAgentLoop(
  systemPrompt: string,
  userContent: string,
  sandboxPath: string,
  logs: string[],
  claudeTools: AIToolDef[]
): Promise<boolean> {
  const messages: AIMessage[] = [{ role: 'user', content: userContent }];
  let iterations = 0;

  while (true) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      logs.push(`WARNING: Max tool iterations (${MAX_TOOL_ITERATIONS}) reached.`);
      return false;
    }
    iterations++;

    const response = await provider.chat({
      model: models.strong,
      maxTokens: 16384,
      system: systemPrompt,
      tools: claudeTools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        logs.push(block.text.trim().slice(0, 500));
      }
    }

    if (response.stopReason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: AIContentBlock[] = [];
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

async function runAgentLoopWithDiscovery(
  systemPrompt: string,
  userContent: string,
  sandboxPath: string,
  logs: string[],
  claudeTools: AIToolDef[],
  extraTools: AvailableTool[],
): Promise<boolean> {
  const messages: AIMessage[] = [{ role: 'user', content: userContent }];
  let iterations = 0;
  const extraToolMap = new Map(extraTools.map((t) => [t.name, t]));

  while (true) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      logs.push(`WARNING: Max tool iterations (${MAX_TOOL_ITERATIONS}) reached.`);
      return false;
    }
    iterations++;

    const response = await provider.chat({
      model: models.strong,
      maxTokens: 16384,
      system: systemPrompt,
      tools: claudeTools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        logs.push(block.text.trim().slice(0, 500));
      }
    }

    if (response.stopReason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: AIContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          if (block.name === 'discover_tools') {
            // Activate requested tools
            const requested = (block.input as { tools: string }).tools.split(',').map((s) => s.trim());
            const activated: string[] = [];
            for (const name of requested) {
              const tool = extraToolMap.get(name);
              if (tool) {
                claudeTools.push(...buildClaudeTools([tool]));
                extraToolMap.delete(name);
                activated.push(name);
              }
            }
            const result = activated.length > 0
              ? `Activated tools: ${activated.join(', ')}. You can now use them.`
              : `No matching tools found for: ${requested.join(', ')}`;
            logs.push(`Tool discovery: ${result}`);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          } else {
            logs.push(`Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
            const result = await handleToolCall(
              block.name,
              block.input as Record<string, unknown>,
              sandboxPath,
            );
            logs.push(`  Result: ${result.slice(0, 200)}`);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }
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
  setCurrentRunId(req.runId);
  const sandboxPath = req.sandboxPath ?? createSandbox(req.runId);
  const logs: string[] = [];

  if (!req.sandboxPath) {
    await gitInit(sandboxPath);
    logs.push(`Sandbox created at ${sandboxPath}`);
  }

  // Start with tools matching the task type — builder can discover more
  const allTools = req.availableTools && req.availableTools.length > 0
    ? req.availableTools
    : getDefaultTools();
  const taskToolSet = TOOLS_BY_TYPE[req.task.type] ?? TOOLS_BY_TYPE.code;
  const initialTools = allTools.filter((t) => taskToolSet.has(t.name));
  const extraTools = allTools.filter((t) => !taskToolSet.has(t.name));

  logs.push(`Initial tools (${req.task.type}): ${initialTools.map((t) => t.name).join(', ')}`);

  const systemPrompt = buildSystemPrompt(req.architecture, initialTools);
  let claudeTools = buildClaudeTools(initialTools);

  // Add discover_tools meta-tool if there are extra tools available
  if (extraTools.length > 0) {
    claudeTools.push({
      name: 'discover_tools',
      description: `Request additional tools. Available: ${extraTools.map((t) => `${t.name} (${t.description.slice(0, 60)})`).join(', ')}`,
      input_schema: {
        type: 'object' as const,
        properties: {
          tools: { type: 'string', description: 'Comma-separated tool names to activate' },
        },
        required: ['tools'],
      },
    });
  }

  const userContent = [
    `Run ID: ${req.runId}`,
    '',
    formatTaskContext(req.task, req.phase, req.constraints, req.completedTasks),
  ].join('\n');

  // Custom agent loop with tool discovery support
  const success = await runAgentLoopWithDiscovery(
    systemPrompt, userContent, sandboxPath, logs, claudeTools, extraTools,
  );
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
  setCurrentRunId(req.runId);
  const sandboxPath = req.previousBuildResult.sandboxPath;
  const logs: string[] = [`Fix iteration ${req.iteration} started for task ${req.task.id}`];

  // Use same tools as the original build
  const availableTools = getDefaultTools();
  const systemPrompt = buildSystemPrompt(req.architecture, availableTools);
  const claudeTools = buildClaudeTools(availableTools);

  // Format QA issues with severity and file paths for precise debugging
  const issueLines = (req.qaIssues ?? []).map((issue) =>
    `  [${issue.severity.toUpperCase()}]${issue.file ? ` ${issue.file}:` : ''} ${issue.description}`
  );

  const userContent = [
    `Run ID: ${req.runId} (fix iteration ${req.iteration})`,
    '',
    `Task: [${req.task.id}] (${req.task.type}) ${req.task.description}`,
    '  Acceptance Criteria:',
    ...req.task.acceptanceCriteria.map((c) => `    - ${c}`),
    '',
    '=== QA FAILURE REPORT ===',
    '',
    'The previous implementation did NOT pass QA. Here is the diagnosis:',
    '',
    req.delta,
    '',
    ...(issueLines.length > 0 ? [
      'Specific issues found by QA:',
      ...issueLines,
      '',
    ] : []),
    ...(req.previousBuildResult.logs.length > 0 ? [
      'Relevant build logs from previous attempt (last 10):',
      ...req.previousBuildResult.logs.slice(-10).map((l) => `  ${l}`),
      '',
    ] : []),
    '=== END QA REPORT ===',
    '',
    'INSTRUCTIONS:',
    '1. First, READ the files mentioned in the QA issues above to understand the current state.',
    '2. Identify the root cause — do not guess, verify by reading the code.',
    '3. Make TARGETED fixes only. Do not rewrite files unless necessary.',
    '4. After fixing, VERIFY your changes work (e.g. run the build, check the output).',
    '5. Commit the changes.',
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
