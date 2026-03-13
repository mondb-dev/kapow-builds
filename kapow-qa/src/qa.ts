import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { TaskGraph, BuildResult, QAResult, Issue } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a senior QA engineer conducting a thorough code review and acceptance test.

You will receive:
1. A TaskGraph with tasks and their acceptance criteria
2. A BuildResult with the list of artifacts produced, build logs, and the sandbox path

Your job:
- For each task, check whether its acceptance criteria are met based on evidence in the artifacts and logs
- Identify issues at three severity levels:
  - critical: task is incomplete, broken, or missing entirely
  - major: task works but is wrong in a significant way (wrong logic, missing edge cases, security issue)
  - minor: style, naming, missing docs, non-blocking issues
- Write a delta: a targeted, actionable description of exactly what is wrong and how to fix it
  (the builder will receive this delta to make targeted fixes — be specific, not vague)

Respond ONLY with a valid JSON object:
{
  "passed": true | false,
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "taskId": "task_1",
      "description": "...",
      "file": "optional/path/to/file.ts"
    }
  ],
  "delta": "Targeted description of what needs to be fixed. Be specific about files, functions, and lines if possible."
}

passed = true only if there are zero critical or major issues.
Do not include markdown, code fences, or any text outside the JSON object.`;

function readArtifactContents(
  sandboxPath: string,
  artifacts: BuildResult['artifacts']
): string {
  const lines: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.type !== 'file') continue;
    const fullPath = join(sandboxPath, artifact.path);
    const resolvedBase = resolve(sandboxPath);
    const resolvedPath = resolve(fullPath);
    if (!resolvedPath.startsWith(resolvedBase + '/')) {
      lines.push(`--- ${artifact.path} (PATH BLOCKED) ---`);
      continue;
    }
    if (!existsSync(fullPath)) {
      lines.push(`--- ${artifact.path} (MISSING) ---`);
      continue;
    }
    try {
      const content = readFileSync(fullPath, 'utf-8');
      // Truncate very large files
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
      lines.push(`--- ${artifact.path} ---`);
      lines.push(truncated);
    } catch {
      lines.push(`--- ${artifact.path} (UNREADABLE) ---`);
    }
  }
  return lines.join('\n');
}

export async function runQA(
  runId: string,
  taskGraph: TaskGraph,
  buildResult: BuildResult
): Promise<QAResult> {
  const artifactContents = readArtifactContents(buildResult.sandboxPath, buildResult.artifacts);

  const userContent = [
    `Run ID: ${runId}`,
    `Task Graph ID: ${taskGraph.id}`,
    '',
    '=== TASK GRAPH ===',
    '',
    'Original Plan:',
    taskGraph.originalPlan,
    '',
    'Constraints:',
    ...taskGraph.constraints.map((c) => `- ${c}`),
    '',
    'Tasks and Acceptance Criteria:',
    ...taskGraph.tasks.map(
      (t) =>
        `\n[${t.id}] (${t.type}) ${t.description}\n` +
        `  Acceptance Criteria:\n` +
        t.acceptanceCriteria.map((c) => `    - ${c}`).join('\n')
    ),
    '',
    '=== BUILD RESULT ===',
    '',
    `Success: ${buildResult.success}`,
    `Artifacts (${buildResult.artifacts.length}):`,
    ...buildResult.artifacts.map((a) => `  - ${a.path} (${a.type})`),
    '',
    'Build Logs (last 50 entries):',
    ...buildResult.logs.slice(-50).map((l) => `  ${l}`),
    '',
    '=== ARTIFACT CONTENTS ===',
    '',
    artifactContents || '(no file contents available)',
  ].join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  if (!message.content?.length) {
    throw new Error('QA returned empty response');
  }
  const content = message.content[0];
  if (content.type !== 'text') {
    throw new Error('QA returned non-text response');
  }

  let parsed: { passed: boolean; issues: Issue[]; delta: string };
  try {
    const raw = content.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`QA returned invalid JSON: ${err}\n\nRaw response:\n${content.text}`);
  }

  return {
    runId,
    passed: parsed.passed ?? false,
    issues: parsed.issues ?? [],
    delta: parsed.delta ?? '',
  };
}
