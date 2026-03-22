import { getAI } from 'kapow-shared';
import { randomUUID } from 'crypto';
import type { ProjectPlan, Phase, ArchitectureDoc } from 'kapow-shared';

const { provider, models } = getAI();

const SYSTEM_PROMPT = `You are the Planner — a pragmatic tech lead who ships fast and hates waste.

Your #1 rule: MATCH THE PLAN TO THE REQUEST SIZE.

- A "hello world" or single-file task = 1 phase, 1-2 tasks. Do NOT add setup/config/testing phases for trivial work.
- A simple website or script = 1 phase, 2-4 tasks.
- A medium app with multiple features = 2-3 phases, 5-10 tasks.
- A complex multi-service system = 3+ phases, 10+ tasks.

If the request can be done in one file, plan ONE task that creates that file. Do not split "create index.html" and "add CSS" and "add JS" into separate tasks when they belong in a single file or a single task.

OVER-PLANNING IS A BUG. Every extra task adds latency, API calls, and failure points. When in doubt, fewer tasks.

When you receive a client brief:

1. GAUGE COMPLEXITY FIRST. Read the brief and decide: is this trivial (1-2 tasks), simple (3-5 tasks), medium (5-10), or complex (10+)? Plan accordingly.

2. CHALLENGE THE SCOPE. Strip vanity features, over-engineering, and premature abstractions. A "hello world" does not need a build system, testing framework, or CI pipeline. Document what you removed in resolvedAmbiguities.

3. DESIGN THE ARCHITECTURE. What is being built, what tech stack, file structure, conventions. Keep it proportional — a static HTML page doesn't need an architecture essay.

4. BREAK INTO TASKS. Each task must produce a tangible, testable outcome. Combine related work into single tasks rather than splitting atomically. "Create index.html with HTML structure, CSS styling, and JS interactivity" is ONE task, not three.

5. WRITE TESTABLE ACCEPTANCE CRITERIA. Every criterion must be verifiable by reading code, running a command, or checking output.

6. ANTICIPATE FAILURE MODES. Call out known pitfalls in architecture.notes.

Respond ONLY with a valid JSON object matching this schema:
{
  "phases": [
    {
      "id": "phase_1",
      "name": "Project Foundation",
      "description": "...",
      "tasks": [
        {
          "id": "phase_1_task_1",
          "description": "...",
          "type": "code",
          "dependencies": [],
          "acceptanceCriteria": ["...", "..."]
        }
      ],
      "dependencies": []
    }
  ],
  "constraints": ["..."],
  "architecture": {
    "overview": "what is being built and why",
    "techStack": "languages, frameworks, versions, and why each was chosen",
    "fileStructure": "planned directory layout with key files",
    "conventions": "naming, patterns, error handling approach",
    "resolvedAmbiguities": ["what the client asked for vs what they actually need"],
    "notes": "gotchas, pitfalls, and context the Builder needs"
  }
}

Task types: code | shell | browser | file | api
Task IDs must be globally unique (e.g. phase_1_task_1, phase_2_task_3).
Phase dependencies reference other phase IDs. Task dependencies reference task IDs within the same phase.
Do not include markdown, code fences, or any text outside the JSON object.`;

function normalizePlannerJson(rawText: string): string {
  const withoutFences = rawText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const firstBrace = withoutFences.indexOf('{');
  const lastBrace = withoutFences.lastIndexOf('}');
  const isolatedJson =
    firstBrace >= 0 && lastBrace > firstBrace
      ? withoutFences.slice(firstBrace, lastBrace + 1)
      : withoutFences;

  return isolatedJson
    .replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)":/gm, '$1"$2":')
    .replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/gm, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
}

export async function createProjectPlan(
  runId: string,
  brief: string,
  recipes?: string,
  preferences?: string
): Promise<ProjectPlan> {
  const userParts: string[] = [`Run ID: ${runId}`];

  if (preferences) {
    userParts.push('', preferences);
  }
  if (recipes) {
    userParts.push('', recipes);
  }

  userParts.push('', `Client Brief:\n${brief}`);

  let rawText = '';
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const message = await provider.chat({
      model: models.balanced,
      maxTokens: 32768,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userParts.join('\n'),
        },
      ],
    });

    if (!message.content?.length) {
      if (attempt < maxAttempts) continue;
      throw new Error('Planner returned empty response after retries');
    }

    const content = message.content[0];
    if (content.type !== 'text' || !content.text.trim() || content.text.includes('[Gemini returned empty response')) {
      if (attempt < maxAttempts) continue;
      throw new Error(`Planner returned unusable response: ${content.type === 'text' ? content.text.slice(0, 200) : content.type}`);
    }

    rawText = content.text.trim();
    break;
  }

  let parsed: {
    phases: Phase[];
    constraints: string[];
    architecture: ArchitectureDoc;
  };

  // Strip markdown code fences if present (handles truncated responses without closing fence)
  if (rawText.startsWith('```')) {
    rawText = rawText.replace(/^```(?:json)?\s*\n?/, '');
    rawText = rawText.replace(/\n?```\s*$/, '');
    rawText = rawText.trim();
  }

  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const repaired = normalizePlannerJson(rawText);

    try {
      parsed = JSON.parse(repaired);
    } catch (repairErr) {
      throw new Error(`Planner returned invalid JSON: ${repairErr}\n\nRaw response:\n${rawText.slice(0, 500)}`);
    }
  }

  if (!Array.isArray(parsed.phases) || parsed.phases.length === 0) {
    throw new Error('Planner returned empty phase list');
  }

  for (const phase of parsed.phases) {
    if (!Array.isArray(phase.tasks) || phase.tasks.length === 0) {
      throw new Error(`Phase "${phase.id}" has no tasks`);
    }
  }

  const projectPlan: ProjectPlan = {
    id: randomUUID(),
    originalBrief: brief,
    phases: parsed.phases,
    constraints: parsed.constraints ?? [],
    architecture: parsed.architecture,
  };

  return projectPlan;
}
