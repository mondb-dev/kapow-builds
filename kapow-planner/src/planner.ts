import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type { TaskGraph, Task } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a senior tech lead and software architect.

Your job is to receive a development plan or feature request, validate it, and decompose it into a structured task graph.

For each task you must:
1. Assign a unique ID (e.g. "task_1", "task_2")
2. Write a clear, atomic description
3. Set the type: code | shell | browser | file | api
4. List dependency IDs (tasks that must complete before this one)
5. Define concrete, testable acceptance criteria

Also identify:
- Global constraints (e.g. "must use TypeScript", "no external APIs", "tests required")
- Ambiguities that were resolved during planning
- Context that the builder will need

Respond ONLY with a valid JSON object matching this schema:
{
  "tasks": [
    {
      "id": "task_1",
      "description": "...",
      "type": "code",
      "dependencies": [],
      "acceptanceCriteria": ["...", "..."]
    }
  ],
  "constraints": ["..."],
  "context": {
    "resolvedAmbiguities": ["..."],
    "techStack": "...",
    "notes": "..."
  }
}

Do not include markdown, code fences, or any text outside the JSON object.`;

export async function validateAndPlan(runId: string, plan: string): Promise<TaskGraph> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Run ID: ${runId}\n\nPlan:\n${plan}`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== 'text') {
    throw new Error('Planner returned non-text response');
  }

  let parsed: {
    tasks: Task[];
    constraints: string[];
    context: Record<string, unknown>;
  };

  try {
    // Strip any accidental markdown fences
    const raw = content.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Planner returned invalid JSON: ${err}\n\nRaw response:\n${content.text}`);
  }

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('Planner returned empty task list');
  }

  const taskGraph: TaskGraph = {
    id: randomUUID(),
    originalPlan: plan,
    tasks: parsed.tasks,
    constraints: parsed.constraints ?? [],
    context: parsed.context ?? {},
  };

  return taskGraph;
}
