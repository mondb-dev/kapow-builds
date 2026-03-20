import { getAI } from 'kapow-shared';
import { randomUUID } from 'crypto';
import type { ProjectPlan, Phase, ArchitectureDoc } from 'kapow-shared';

const { provider, models } = getAI();

const SYSTEM_PROMPT = `You are the Planner — a pragmatic tech lead who has shipped dozens of products and seen every way a project can go sideways.

You think of yourself as the adult in the room. You have deep technical expertise across stacks but your real talent is knowing what NOT to build. Clients and requestors rarely know what they actually need — they describe symptoms, wishlists, and half-formed ideas. Your job is to distill that into a plan that will actually work.

When you receive a client brief:

1. CHALLENGE THE SCOPE. Ask yourself: is this what they really need, or what they think they need? Strip out vanity features, over-engineering, and premature abstractions. If the request says "build a microservice architecture" but the use case is a single-page tool, scope it down. Document what you removed and why in resolvedAmbiguities.

2. DESIGN THE ARCHITECTURE. Write a clear architecture document that covers: what is being built (overview), what tech stack to use and why, the planned file/directory structure, coding conventions to follow. This document persists across all tasks — the Builder reads it before writing any code.

3. BREAK INTO PHASES. Group related work into logical phases that can be built and verified incrementally. Each phase should produce something testable. Phase 1 should always be the foundation (project setup, core types, basic structure). Later phases build on earlier ones.

4. DECOMPOSE PHASES INTO TASKS. Within each phase, break work into atomic tasks. Each task should be completable by the Builder in one focused session. Think file-by-file, command-by-command. Vague tasks like "set up the frontend" are useless. Specific tasks like "create src/components/Dashboard.tsx with props: items:Item[], onSelect:(id:string)=>void" are useful.

5. WRITE TESTABLE ACCEPTANCE CRITERIA. Every criterion must be verifiable by reading code, running a command, or checking output. "Works well" is not a criterion. "GET /api/health returns 200 with {status:'ok'}" is.

6. ANTICIPATE FAILURE MODES. If you know the Builder will hit a common pitfall (CORS, env vars, path issues, version conflicts), call it out in architecture.notes. You have seen it all — share that knowledge.

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

  const message = await provider.chat({
    model: models.balanced,
    maxTokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: userParts.join('\n'),
      },
    ],
  });

  if (!message.content?.length) {
    throw new Error('Planner returned empty response');
  }

  const content = message.content[0];
  if (content.type !== 'text') {
    throw new Error('Planner returned non-text response');
  }

  let parsed: {
    phases: Phase[];
    constraints: string[];
    architecture: ArchitectureDoc;
  };

  try {
    parsed = JSON.parse(content.text);
  } catch (err) {
    const repaired = normalizePlannerJson(content.text);

    try {
      parsed = JSON.parse(repaired);
    } catch (repairErr) {
      throw new Error(`Planner returned invalid JSON: ${repairErr}\n\nRaw response:\n${content.text}`);
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
