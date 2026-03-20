import { getAI } from 'kapow-shared';
import type { TaskQAResult, GateResult, Artifact } from 'kapow-shared';

const MAX_ITERATIONS = 3;

const { provider, models } = getAI();

const DIAGNOSIS_SYSTEM_PROMPT = `You are the Gate — the final decision-maker in the build pipeline. You have seen the plan, the build, and the QA results across ${MAX_ITERATIONS} retry attempts for a single task, and it still failed.

Your job is to write a post-mortem that is honest, direct, and useful. You are writing for the human who submitted this plan — they need to understand what went wrong and what to do next.

Your diagnosis must cover:
1. WHAT WAS ATTEMPTED. One sentence on the task goal.
2. ROOT CAUSE. What actually failed and why. Was it a bad task spec (unclear requirements, impossible constraints)? Or an implementation failure (wrong API usage, missing deps, logic bugs)? Be specific — cite the QA issues.
3. PATTERN RECOGNITION. Did the same issue persist across all ${MAX_ITERATIONS} iterations, or did the Builder fix some things but introduce new ones? This tells the human whether the problem is fixable with better instructions or fundamentally flawed.
4. RECOMMENDED NEXT STEP. One concrete action: rewrite the task, simplify it, provide missing context, or escalate to a human.

Write 2-4 paragraphs. Plain prose, no markdown headers, no bullet points. Be direct — if the task spec was bad, say so. If the Builder choked on something specific, name it.`;

async function generateDiagnosis(qaResult: TaskQAResult, iteration: number): Promise<string> {
  const issuesSummary = qaResult.issues
    .map((i) => `[${i.severity.toUpperCase()}] ${i.taskId}: ${i.description}${i.file ? ` (${i.file})` : ''}`)
    .join('\n');

  const message = await provider.chat({
    model: models.fast,
    maxTokens: 1024,
    system: DIAGNOSIS_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `Run ID: ${qaResult.runId}`,
          `Task ID: ${qaResult.taskId}`,
          `Total iterations attempted: ${iteration}`,
          '',
          'Final QA delta (what was wrong):',
          qaResult.delta,
          '',
          'Issues found:',
          issuesSummary || '(none recorded)',
        ].join('\n'),
      },
    ],
  });

  if (!message.content?.length) return 'Diagnosis generation failed: empty response.';
  const content = message.content[0];
  if (content.type !== 'text') return 'Diagnosis generation failed.';
  return content.text;
}

export async function evaluate(
  runId: string,
  qaResult: TaskQAResult,
  iteration: number,
  artifacts?: Artifact[]
): Promise<GateResult> {
  if (qaResult.passed) {
    return { runId, ciSignal: 'go', iteration, artifacts };
  }

  if (iteration < MAX_ITERATIONS) {
    const delta =
      qaResult.delta.trim() ||
      qaResult.issues
        .filter((i) => i.severity === 'critical' || i.severity === 'major')
        .map((i) => `- [${i.severity}] ${i.taskId}: ${i.description}`)
        .join('\n');

    return { runId, ciSignal: 'no-go', iteration, delta };
  }

  const diagnosis = await generateDiagnosis(qaResult, iteration);
  return { runId, ciSignal: 'escalate', iteration, diagnosis };
}
