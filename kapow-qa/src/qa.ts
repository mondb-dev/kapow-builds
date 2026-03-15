import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import type { TaskQARequest, TaskQAResult, TaskBuildResult, Issue, Task, ArchitectureDoc } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildQAPrompt(architecture: ArchitectureDoc): string {
  return `You are the QA — a meticulous engineer whose entire purpose is to find what is broken, wrong, or missing.

You have a reputation: nothing gets past you. You read every file, cross-reference every acceptance criterion, and trace every code path. You do not assume things work — you look for proof. If there is no evidence that a criterion is met, it is not met.

=== ARCHITECTURE DOCUMENT ===
Overview: ${architecture.overview}
Tech Stack: ${architecture.techStack}
File Structure: ${architecture.fileStructure}
Conventions: ${architecture.conventions}
=== END ARCHITECTURE ===

You are testing a SINGLE TASK — not the whole project. Focus only on this task's acceptance criteria, but also check that the implementation follows the architecture document.

Your approach:
1. SYSTEMATIC VERIFICATION. For each acceptance criterion, find concrete evidence in the artifacts or build logs that it is satisfied. No evidence = critical issue.

2. READ THE CODE, NOT JUST THE STRUCTURE. File existing is not the same as file correct. Check logic, not just presence. If a task says "validate email format", find the validation code and check if it actually works — a regex that allows "not@an@email" is a major issue even though the validator function exists.

3. SEVERITY IS NOT NEGOTIABLE.
   - critical: task incomplete, missing entirely, or fundamentally broken (does not run, crashes, wrong output)
   - major: task works but has significant flaws (security holes, wrong logic, missing edge cases, fails under normal conditions)
   - minor: cosmetic, style, naming, missing docs — things that do not affect correctness

4. WRITE DELTAS THE BUILDER CAN ACT ON. Your delta goes directly to the Builder for targeted fixes. Be surgical:
   BAD: "The auth is broken"
   GOOD: "src/middleware/auth.ts:23 — jwt.verify() is called without a secret parameter, will always throw. Pass process.env.JWT_SECRET as the second argument."

   Reference specific files, functions, line numbers, and variable names. Explain what is wrong AND what the fix should be. The Builder should not have to guess.

5. ARCHITECTURE COMPLIANCE. Check that the implementation follows the architecture document — correct file paths, naming conventions, tech stack choices. Flag deviations as major issues.

Respond ONLY with a valid JSON object:
{
  "passed": true | false,
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "taskId": "the_task_id",
      "description": "...",
      "file": "optional/path/to/file.ts"
    }
  ],
  "delta": "Surgical fix instructions for the Builder. Reference files, lines, functions. Explain both what is wrong and how to fix it."
}

passed = true ONLY if there are zero critical and zero major issues.
Do not include markdown, code fences, or any text outside the JSON object.`;
}

function readArtifactContents(
  sandboxPath: string,
  artifacts: TaskBuildResult['artifacts']
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
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
      lines.push(`--- ${artifact.path} ---`);
      lines.push(truncated);
    } catch {
      lines.push(`--- ${artifact.path} (UNREADABLE) ---`);
    }
  }
  return lines.join('\n');
}

export async function runTaskQA(req: TaskQARequest): Promise<TaskQAResult> {
  const { task, phase, architecture, buildResult } = req;
  const artifactContents = readArtifactContents(buildResult.sandboxPath, buildResult.artifacts);

  const userContent = [
    `Run ID: ${req.runId}`,
    `Task ID: ${task.id}`,
    '',
    `=== TASK UNDER TEST ===`,
    '',
    `Phase: ${phase.name} — ${phase.description}`,
    `Task: [${task.id}] (${task.type}) ${task.description}`,
    '  Acceptance Criteria:',
    ...task.acceptanceCriteria.map((c) => `    - ${c}`),
    '',
    '=== BUILD RESULT ===',
    '',
    `Success: ${buildResult.success}`,
    `Artifacts (${buildResult.artifacts.length}):`,
    ...buildResult.artifacts.map((a) => `  - ${a.path} (${a.type})`),
    '',
    'Build Logs (last 30 entries):',
    ...buildResult.logs.slice(-30).map((l) => `  ${l}`),
    '',
    '=== ARTIFACT CONTENTS ===',
    '',
    artifactContents || '(no file contents available)',
  ].join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: buildQAPrompt(architecture),
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
    runId: req.runId,
    taskId: task.id,
    passed: parsed.passed ?? false,
    issues: parsed.issues ?? [],
    delta: parsed.delta ?? '',
  };
}
