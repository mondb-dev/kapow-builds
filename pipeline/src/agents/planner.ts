import { getAI } from 'kapow-shared';
import { randomUUID } from 'crypto';
import type { ProjectPlan, Phase, ProjectContext, TaskIntent } from 'kapow-shared';
import { wrapUntrusted, buildUntrustedPreamble, resetPromptSentinel } from './prompt-safety.js';

const { provider, models } = getAI();

const THINKING_PROMPT = `You are a seasoned technical lead reviewing a project brief before committing to a plan.

Think carefully and answer each question before writing a single task:

1. SCOPE: What exactly is being asked for? What is NOT being asked for (scope boundaries)?

2. INTENT: What is the primary intent — development, research, writing, analysis, audit, or creative? Why?

3. SIZE: Trivial (1 task), small (2–4), medium (5–10), or complex (10+)? Justify with specifics.

4. NATURAL WORK BOUNDARIES: What chunks of work are truly independent and can run sequentially?
   - Things that MUST be written together (tightly coupled) belong in ONE task.
   - Things that are genuinely separable belong in different tasks.
   - Do NOT split work just to make more tasks. Split only when separation adds value.

5. PHASE STRUCTURE: What are the phases? Each phase is a coherent deliverable milestone.
   - Phase N+1 should not start until Phase N is fully verified.
   - Cross-phase dependencies: tasks may only list dependencies on other tasks IN THE SAME phase.
     Cross-phase ordering is handled by phase sequencing, not task dependency fields.

6. ACCEPTANCE CRITERIA: For each task, what does "done" look like in a way QA can check?
   - Bad: "movement works correctly"
   - Good: "pressing ArrowLeft moves block one cell left; block stops at x=0 boundary"
   Criteria must be specific and mechanically verifiable.

7. DELIVERY ARC: How does this work get into users' hands?
   - For web/app development: the final phase MUST be github_create_repo → deploy (Vercel/Netlify/Firebase).
   - For writing/research: the final task MUST produce a named output file.
   - Do not end a plan mid-build.

8. RISKS: What could go wrong? What assumptions are you making that might be wrong?

Be thorough. This reasoning directly shapes the quality of the plan.`;

const SYSTEM_PROMPT = `You are the Planner — a pragmatic lead who ships fast and hates waste.

Your #1 rule: MATCH THE PLAN TO THE REQUEST SIZE.

- A single deliverable (one file, one answer, one report) = 1 phase, 1 task.
- A small project or short report = 1 phase, 2-4 tasks.
- A medium project with multiple deliverables = 2-3 phases, 5-10 tasks.
- A large multi-part effort = 3+ phases, 10+ tasks.

If the request can be done in one file, plan ONE task. Do not split atomic work into separate tasks.

OVER-PLANNING IS A BUG. Every extra task adds latency, API calls, and failure points. When in doubt, fewer tasks.

=== STEP 1: CLASSIFY INTENT ===

Before planning, classify the brief into ONE primary intent:

- "development" — building software, scripts, configs, infrastructure, automation.
  Signals: code, app, website, API, script, server, deploy, build, install, database, implement, create (software).

- "research" — finding, synthesizing, and citing information from multiple sources.
  Signals: research, find out, what is, compare, investigate, sources, literature, market analysis, look into, gather info.

- "writing" — producing prose output: articles, blog posts, reports, documentation, emails, copy.
  Signals: write, draft, compose, article, blog post, copy, documentation, letter, proposal, report.

- "analysis" — examining data, situations, or artifacts to produce structured findings and recommendations.
  Signals: analyze, evaluate, assess, benchmark, compare metrics, data, trends, strengths/weaknesses, SWOT.

- "audit" — evaluating an existing artifact (website, codebase, document, process) against standards or criteria.
  Signals: audit, review, test, QA, check, accessibility, usability, compliance, assess. PLUS a target (URL, file, system name).
  DETECTION RULE: If the brief contains BOTH a URL/domain AND audit-intent words, use "audit".

- "creative" — generating artistic, design, or imaginative output: poetry, fiction, naming, brainstorming, visual concepts.
  Signals: poem, story, creative, brainstorm, name ideas, tagline, slogan, design concept, haiku, song.

If the brief combines intents (e.g., "research X then write a report"), use the FINAL DELIVERABLE's intent. A research report is "writing" with research tasks feeding it. A website that needs competitive analysis first is "development."

=== STEP 2: PLAN BY INTENT ===

**development** — Plan as software: architecture, implementation tasks, integration.
  approach = tech stack and frameworks. structure = file/directory layout. conventions = coding patterns.
  DEPLOY RULE: Any web project (website, web app, frontend, landing page) MUST include a final deploy phase with these tasks in order:
    1. github_create_repo — push code to a new GitHub repo
    2. vercel_deploy OR netlify_deploy OR firebase_deploy — publish to a live URL
  The final task MUST produce a live https:// URL. No exceptions. Do not skip this for "demo" or "prototype" projects.

**research** — Plan as investigation: source identification, data gathering, synthesis, output formatting.
  approach = research methodology (web search, document analysis, comparative review).
  structure = output format (report sections, data tables, bibliography).
  conventions = citation style, objectivity requirements, source quality bar.

**writing** — Plan as editorial: outline/structure, drafting, revision.
  approach = writing style, tone, audience, format (markdown, HTML, plain text).
  structure = document sections and flow.
  conventions = tone (formal/casual/technical), word count targets, formatting rules.

**analysis** — Plan as structured evaluation: data gathering, framework application, findings, recommendations.
  approach = analytical framework (SWOT, cost-benefit, comparative matrix, statistical).
  structure = analysis output format (tables, narrative sections, recommendations).
  conventions = objectivity, evidence requirements, recommendation format.

**audit** — Plan as standards-based evaluation of an existing artifact.
  approach = audit methodology, standards/criteria being applied.
  structure = findings format (severity-categorized issues, evidence, recommendations).
  conventions = evidence requirements (screenshots, citations), severity classification.
  IMPORTANT: Audit tasks do NOT modify the target. They are read-only observation.

**creative** — Plan as creative production: concept exploration, drafting, refinement.
  approach = creative constraints (form, genre, medium, style references).
  structure = output format and length.
  conventions = artistic guidelines, brand voice if applicable.

=== STEP 3: PLANNING PROCESS ===

1. GAUGE COMPLEXITY. Read the brief and decide: trivial (1 task), simple (2-4), medium (5-10), or complex (10+)?

2. CHALLENGE THE SCOPE. Strip unnecessary extras. A single-file task does not need setup phases. A short report does not need a literature review phase. Document what you removed in resolvedAmbiguities.

3. DEFINE THE CONTEXT. What is being produced, what approach/methodology, output structure, conventions. Keep it proportional.

4. BREAK INTO TASKS. Each task must produce a tangible, verifiable outcome. Combine related work.

5. WRITE VERIFIABLE ACCEPTANCE CRITERIA. Every criterion must be checkable — by reading output, checking structure, verifying content, or running code (for development tasks only).

6. ANTICIPATE FAILURE MODES. Call out pitfalls in notes.

=== OUTPUT FORMAT ===

Respond ONLY with a valid JSON object:
{
  "intent": "development | research | writing | analysis | audit | creative",
  "phases": [
    {
      "id": "phase_1",
      "name": "...",
      "description": "...",
      "tasks": [
        {
          "id": "phase_1_task_1",
          "description": "...",
          "intent": "development | research | writing | analysis | audit | creative",
          "type": "code | shell | browser | file | api",
          "dependencies": [],
          "acceptanceCriteria": ["...", "..."]
        }
      ],
      "dependencies": []
    }
  ],
  "constraints": ["..."],
  "architecture": {
    "overview": "what is being produced and why",
    "approach": "methodology, tech stack, or creative framework — depends on intent",
    "structure": "output structure: files, sections, data layout",
    "conventions": "style, tone, patterns, standards to follow",
    "resolvedAmbiguities": ["assumptions made about unclear requirements"],
    "notes": "risks, pitfalls, context for the executor"
  }
}

Task type (tool hint): code | shell | browser | file | api
  - "file" for tasks that only write output files (writing, creative, most analysis)
  - "browser" for tasks that need to navigate websites (audit, research with web sources)
  - "code" for software development tasks
  - "shell" for tasks needing command execution
  - "api" for API integration tasks

Task IDs must be globally unique (e.g. phase_1_task_1, phase_2_task_3).
Phase dependencies reference other phase IDs.
Task dependencies MUST only reference task IDs within the SAME phase. Cross-phase ordering is enforced by phase sequencing — never put a task from another phase in a task's dependencies array.
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

async function runThinkingTurn(brief: string, preferences?: string): Promise<string> {
  const context = [
    preferences ? `User preferences: ${preferences}` : '',
    `Brief: ${brief}`,
  ].filter(Boolean).join('\n\n');

  try {
    const response = await provider.chat({
      model: models.strong,
      maxTokens: 8192,
      system: 'You are a seasoned technical lead. Think carefully and be specific.',
      messages: [{ role: 'user', content: `${THINKING_PROMPT}\n\n${context}` }],
    });
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('\n')
      .trim();
    console.log(`[planner] Thinking turn complete (${text.length} chars)`);
    return text;
  } catch (err) {
    console.warn(`[planner] Thinking turn failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return '';
  }
}

export async function createProjectPlan(
  runId: string,
  brief: string,
  recipes?: string,
  preferences?: string
): Promise<ProjectPlan> {
  resetPromptSentinel();

  // ── Thinking turn: reason about scope and structure before planning ──
  const thinking = await runThinkingTurn(brief, preferences);

  const systemPrompt = `${SYSTEM_PROMPT}\n\n${buildUntrustedPreamble()}`;
  const userParts: string[] = [`Run ID: ${runId}`];

  const wrappedPrefs = wrapUntrusted('user_preferences', preferences);
  if (wrappedPrefs) userParts.push('', wrappedPrefs);

  const wrappedRecipes = wrapUntrusted('learned_recipes', recipes);
  if (wrappedRecipes) userParts.push('', wrappedRecipes);

  userParts.push('', wrapUntrusted('client_brief', brief));

  if (thinking) {
    userParts.push(
      '',
      '=== PLANNING ANALYSIS (use this to inform your JSON) ===',
      thinking,
      '=== END ANALYSIS ===',
      '',
      'Now output the JSON plan based on the analysis above.',
    );
  }

  let rawText = '';
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const message = await provider.chat({
      model: models.strong,
      maxTokens: 32768,
      system: systemPrompt,
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
    intent?: TaskIntent;
    phases: Phase[];
    constraints: string[];
    architecture: ProjectContext;
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

  // Extract intent — default to 'development' for backward compat
  const VALID_INTENTS = new Set<TaskIntent>(['development', 'research', 'writing', 'analysis', 'audit', 'creative']);
  const projectIntent: TaskIntent = parsed.intent && VALID_INTENTS.has(parsed.intent) ? parsed.intent : 'development';

  // Ensure every task has an intent field
  for (const phase of parsed.phases) {
    for (const task of phase.tasks) {
      if (!task.intent || !VALID_INTENTS.has(task.intent)) {
        task.intent = projectIntent;
      }
    }
  }

  // Normalize architecture field names (accept old techStack/fileStructure from LLM)
  const arch = (parsed.architecture && typeof parsed.architecture === 'object'
    ? parsed.architecture
    : {}) as unknown as Record<string, unknown>;

  const pickStr = (...keys: string[]): string => {
    for (const k of keys) {
      const v = arch[k];
      if (typeof v === 'string') return v;
    }
    return '';
  };
  const pickStrList = (key: string): string[] => {
    const v = arch[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };

  const architecture: ProjectContext = {
    overview: pickStr('overview'),
    approach: pickStr('approach', 'techStack'),
    structure: pickStr('structure', 'fileStructure'),
    conventions: pickStr('conventions'),
    resolvedAmbiguities: pickStrList('resolvedAmbiguities'),
    notes: pickStr('notes'),
  };

  // The planner must give us at least an overview and an approach — without
  // these the builder has no project context to operate on.
  if (!architecture.overview && !architecture.approach) {
    throw new Error(
      `Planner returned architecture missing overview/approach. Raw fields: ${Object.keys(arch).join(', ') || '(none)'}`
    );
  }

  const projectPlan: ProjectPlan = {
    id: randomUUID(),
    originalBrief: brief,
    intent: projectIntent,
    phases: parsed.phases,
    constraints: parsed.constraints ?? [],
    architecture,
  };

  return projectPlan;
}
