import { getAI } from 'kapow-shared';
import type { AIToolDef, AIMessage, AIContentBlock } from 'kapow-shared';
import type { TaskQARequest, TaskQAResult, Issue, ArchitectureDoc, AvailableTool } from './types.js';
import { dispatchTool, allowedTools, registerCoreQATools } from './tool-dispatch.js';

// Register core tools on module load
registerCoreQATools();

const { provider, models } = getAI();

const MAX_TOOL_ITERATIONS = 30;

function buildQAPrompt(architecture: ArchitectureDoc, availableTools: AvailableTool[]): string {
  const toolDocs = availableTools.map((t) => {
    const doc = t.doc;
    return `- ${t.name}: ${doc?.summary ?? t.description}`;
  }).join('\n');

  return `You are the QA — an automated tester with access to the Builder's sandbox. Your job is to PROVE whether a task's implementation works or does not work. You do not guess — you run the code, read the output, and report facts.

You have a reputation: nothing gets past you. You do not assume things work because the code looks right. You run tests, hit endpoints, check build output, and read files to verify every acceptance criterion with evidence.

=== ARCHITECTURE DOCUMENT ===
Overview: ${architecture.overview}
Tech Stack: ${architecture.techStack}
File Structure: ${architecture.fileStructure}
Conventions: ${architecture.conventions}
=== END ARCHITECTURE ===

=== AVAILABLE TOOLS ===
${toolDocs}
=== END TOOLS ===

You are testing a SINGLE TASK. Focus on its acceptance criteria.

YOUR TESTING METHODOLOGY:
1. EXPLORE FIRST. Use file_list and file_read to understand what was built. Check the file structure matches the architecture doc.

2. RUN THE CODE. Use shell_exec to:
   - Run the build (npm run build, npx tsc --noEmit, etc.)
   - Run tests if they exist (npm test, npx jest, etc.)
   - Start a server and curl its endpoints if the task involves an API
   - Execute scripts and check their output
   - Check for TypeScript errors, lint issues, missing deps

3. VERIFY EACH CRITERION. For every acceptance criterion:
   - Find the relevant code with file_read
   - Run a command that proves it works (or fails)
   - Record the evidence (command output, file contents, error messages)

4. CHECK ARCHITECTURE COMPLIANCE.
   - Are files in the correct locations per the architecture doc?
   - Are naming conventions followed?
   - Is the correct tech stack used?

5. SECURITY SCAN. Quick check for obvious issues:
   - Env vars used but not validated at startup?
   - User input passed to shell/SQL/file paths without sanitization?
   - Secrets hardcoded in source files?

IMPORTANT CONSTRAINTS:
- You have READ-ONLY access to the sandbox. You can read files and run commands, but you CANNOT modify files. This is intentional — you are a tester, not a fixer.
- If a command needs to start a server, use a background process and kill it after testing: "node server.js &; sleep 2; curl http://localhost:3000/health; kill %1"
- Keep shell commands short and focused. Do not install additional packages.

After your investigation, you MUST end your response with a JSON verdict (no tool calls after this).
The JSON must be the ONLY content in your final message — no text before or after it.

{
  "passed": true | false,
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "taskId": "the_task_id",
      "description": "What is wrong, with evidence (command output, file contents, error messages)",
      "file": "optional/path/to/file.ts"
    }
  ],
  "delta": "Surgical fix instructions for the Builder. Reference files, lines, functions. Include the actual error output you saw."
}

passed = true ONLY if there are zero critical and zero major issues.
Do not include markdown code fences around the JSON.`;
}

/** QA only gets read-only tools — filter from registry */
const QA_ALLOWED_TOOLS = new Set(['shell_exec', 'file_read', 'file_list']);

function getDefaultQATools(): AvailableTool[] {
  return [
    { id: 'core-shell-exec', name: 'shell_exec', description: 'Execute a shell command in the sandbox (read-only testing)', parameters: [{ name: 'command', type: 'string', description: 'Shell command to execute', required: true }, { name: 'timeout_ms', type: 'number', description: 'Optional timeout in milliseconds (default: 120000)', required: false }], returnType: '{ stdout, stderr, exitCode }' },
    { id: 'core-file-read', name: 'file_read', description: 'Read a file from the sandbox', parameters: [{ name: 'path', type: 'string', description: 'Relative path within sandbox', required: true }], returnType: 'string' },
    { id: 'core-file-list', name: 'file_list', description: 'List directory contents in the sandbox', parameters: [{ name: 'path', type: 'string', description: 'Relative directory path (default: ".")', required: false }], returnType: 'Array<{ name, path, type, size? }>' },
  ];
}

function buildClaudeTools(availableTools: AvailableTool[]): AIToolDef[] {
  // QA only gets read-safe tools
  const filtered = availableTools.filter((t) => QA_ALLOWED_TOOLS.has(t.name));

  return filtered.map((t) => {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];
    for (const p of t.parameters) {
      properties[p.name] = { type: p.type, description: p.description };
      if (p.required) required.push(p.name);
    }
    return {
      name: t.name,
      description: t.doc?.summary ?? t.description,
      input_schema: { type: 'object' as const, properties, required },
    };
  });
}

async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  sandboxPath: string
): Promise<string> {
  return dispatchTool(toolName, toolInput, sandboxPath);
}

export async function runTaskQA(req: TaskQARequest): Promise<TaskQAResult> {
  const { task, phase, architecture, buildResult } = req;
  const sandboxPath = buildResult.sandboxPath;

  // Use tools from registry if provided, otherwise defaults
  const availableTools = req.availableTools && req.availableTools.length > 0
    ? req.availableTools
    : getDefaultQATools();

  const claudeTools = buildClaudeTools(availableTools);

  const userContent = [
    `Run ID: ${req.runId}`,
    `Task ID: ${task.id}`,
    `Sandbox: ${sandboxPath}`,
    '',
    '=== TASK UNDER TEST ===',
    '',
    `Phase: ${phase.name} — ${phase.description}`,
    `Task: [${task.id}] (${task.type}) ${task.description}`,
    '  Acceptance Criteria:',
    ...task.acceptanceCriteria.map((c) => `    - ${c}`),
    '',
    '=== BUILD RESULT ===',
    '',
    `Builder Success: ${buildResult.success}`,
    `Artifacts (${buildResult.artifacts.length}):`,
    ...buildResult.artifacts.slice(0, 50).map((a) => `  - ${a.path} (${a.type})`),
    buildResult.artifacts.length > 50 ? `  ... and ${buildResult.artifacts.length - 50} more` : '',
    '',
    'Build Logs (last 20 entries):',
    ...buildResult.logs.slice(-20).map((l) => `  ${l}`),
    '',
    'Start by exploring the sandbox with file_list, then read key files and run tests to verify each acceptance criterion.',
  ].join('\n');

  const systemPrompt = buildQAPrompt(architecture, availableTools);
  const messages: AIMessage[] = [{ role: 'user', content: userContent }];
  let iterations = 0;

  while (true) {
    if (iterations >= MAX_TOOL_ITERATIONS) {
      return {
        runId: req.runId,
        taskId: task.id,
        passed: false,
        issues: [{
          severity: 'critical',
          taskId: task.id,
          description: 'QA exceeded max tool iterations without reaching a verdict.',
        }],
        delta: 'QA could not complete testing within iteration limit.',
      };
    }
    iterations++;

    const response = await provider.chat({
      model: models.balanced,
      maxTokens: 8192,
      system: systemPrompt,
      tools: claudeTools,
      messages,
    });

    if (response.stopReason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: AIContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await handleToolCall(
            block.name,
            block.input as Record<string, unknown>,
            sandboxPath
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      // end_turn — extract JSON verdict from the final text
      const textBlocks = response.content.filter((b) => b.type === 'text');
      const fullText = textBlocks.map((b) => b.type === 'text' ? b.text : '').join('\n');

      return parseVerdict(req.runId, task.id, fullText);
    }
  }
}

function parseVerdict(runId: string, taskId: string, text: string): TaskQAResult {
  // Try to extract JSON from the response
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  // Find the last JSON object in the text (QA might have commentary before it)
  const jsonMatch = cleaned.match(/\{[\s\S]*"passed"[\s\S]*\}$/);
  if (!jsonMatch) {
    return {
      runId,
      taskId,
      passed: false,
      issues: [{
        severity: 'critical',
        taskId,
        description: `QA did not return a valid JSON verdict. Raw output: ${text.slice(0, 500)}`,
      }],
      delta: 'QA failed to produce a verdict. This is a QA agent error, not a build issue.',
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { passed: boolean; issues: Issue[]; delta: string };
    return {
      runId,
      taskId,
      passed: parsed.passed ?? false,
      issues: parsed.issues ?? [],
      delta: parsed.delta ?? '',
    };
  } catch (err) {
    return {
      runId,
      taskId,
      passed: false,
      issues: [{
        severity: 'critical',
        taskId,
        description: `QA returned invalid JSON: ${err}`,
      }],
      delta: `QA verdict parsing failed. Raw: ${text.slice(0, 500)}`,
    };
  }
}
