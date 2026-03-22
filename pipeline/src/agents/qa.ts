import { getAI } from 'kapow-shared';
import type { AIToolDef, AIMessage, AIContentBlock } from 'kapow-shared';
import type { TaskQARequest, TaskQAResult, Issue, ArchitectureDoc, AvailableTool } from 'kapow-shared';
import { dispatchTool, allowedTools, registerCoreQATools } from './qa-tool-dispatch.js';

// Register core tools on module load
registerCoreQATools();

const { provider, models } = getAI();

const MAX_TOOL_ITERATIONS = 30;

function buildQAPrompt(architecture: ArchitectureDoc, availableTools: AvailableTool[]): string {
  const toolDocs = availableTools.map((t) => {
    const doc = t.doc;
    return `- ${t.name}: ${doc?.summary ?? t.description}`;
  }).join('\n');

  return `You are the QA — you verify whether the builder produced what was asked for. You check facts, not opinions.

=== CRITICAL: MATCH YOUR TESTING TO THE TASK TYPE ===

**DIRECT OUTPUT tasks** (files, documents, content):
→ Just use file_list and file_read to verify the output file exists and has correct content.
→ Do NOT try to npm install, npm build, or start servers. There is no project to build.
→ If the task was "create a poem in poem.txt", read poem.txt and check if it has a poem. That's it.

**Simple project tasks** (HTML page, script):
→ Check files exist and have correct content via file_read.
→ Only run shell_exec if there's actually something to run (e.g., node script.js).

**Full project tasks** (apps with package.json, build steps):
→ Run npm install, build, tests, start servers, curl endpoints.

=== ARCHITECTURE DOCUMENT ===
Overview: ${architecture.overview}
Tech Stack: ${architecture.techStack}
File Structure: ${architecture.fileStructure}
Conventions: ${architecture.conventions}
=== END ARCHITECTURE ===

=== AVAILABLE TOOLS ===
${toolDocs}
=== END TOOLS ===

TESTING STEPS:
1. file_list to see what was built.
2. file_read key files to verify content matches acceptance criteria.
3. ONLY IF the task involves runnable code: use shell_exec to run/test it.
4. Produce your verdict.

IMPORTANT:
- READ-ONLY access. You cannot modify files.
- Be proportional. A one-file task needs a one-step check, not a full CI pipeline.
- If acceptance criteria are met, pass it. Do not invent extra requirements.

You MUST end with a JSON verdict (no tool calls after). The JSON must be the ONLY content in your final message.

{
  "passed": true | false,
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "taskId": "the_task_id",
      "description": "What is wrong, with evidence",
      "file": "optional/path/to/file"
    }
  ],
  "delta": "Fix instructions for the Builder if failed. Be specific."
}

passed = true if acceptance criteria are met. Do not include markdown code fences around the JSON.`;
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
    ...(req.previousQAResults && req.previousQAResults.length > 0 ? [
      '',
      '=== PREVIOUS QA ITERATIONS ===',
      ...req.previousQAResults.map((prev, i) => [
        `Iteration ${i + 1}: ${prev.passed ? 'PASSED' : 'FAILED'}`,
        ...prev.issues.map((issue) => `  [${issue.severity}]${issue.file ? ` ${issue.file}:` : ''} ${issue.description}`),
        prev.delta ? `  Fix requested: ${prev.delta.slice(0, 200)}` : '',
      ].filter(Boolean).join('\n')),
      '',
      'The builder has attempted fixes since the last QA. Check if previous issues are resolved AND if new issues were introduced.',
      '=== END PREVIOUS QA ===',
    ] : []),
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
      maxTokens: 16384,
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

      // If Gemini returned empty/placeholder, retry up to 2 times
      if (!fullText.trim() || fullText.includes('[Gemini returned empty response')) {
        if (iterations < MAX_TOOL_ITERATIONS - 1) {
          messages.push({ role: 'assistant', content: [{ type: 'text', text: fullText || '(empty)' }] });
          messages.push({ role: 'user', content: 'Your previous response was empty. Please provide your QA verdict as a JSON object with "passed", "issues", and "delta" fields.' });
          continue;
        }
      }

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
