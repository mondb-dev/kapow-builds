import Anthropic from '@anthropic-ai/sdk';
import { MAX_ITERATIONS, type QAResult, type GateResult, type Artifact } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DIAGNOSIS_SYSTEM_PROMPT = `You are the Gate — the final decision-maker in the build pipeline. You have seen the plan, the build, and the QA results across ${MAX_ITERATIONS} retry attempts, and the pipeline still failed.

Your job is to write a post-mortem that is honest, direct, and useful. You are writing for the human who submitted this plan — they need to understand what went wrong and what to do next.

Your diagnosis must cover:
1. WHAT WAS ATTEMPTED. One sentence on the goal — not a restatement of the plan, but the core intent.
2. ROOT CAUSE. What actually failed and why. Was it a bad plan (wrong architecture, impossible requirements, missing context)? Or a good plan with implementation failures (wrong API usage, missing deps, logic bugs)? Be specific — cite the QA issues.
3. PATTERN RECOGNITION. Did the same issue persist across all ${MAX_ITERATIONS} iterations, or did the Builder fix some things but introduce new ones? This tells the human whether the problem is fixable with better instructions or fundamentally flawed.
4. RECOMMENDED NEXT STEP. One concrete action: rewrite the plan, simplify the scope, provide missing context (API keys, specs, examples), or break it into smaller pieces.

Write 2-4 paragraphs. Plain prose, no markdown headers, no bullet points. Be direct — if the plan was bad, say so. If the Builder choked on something specific, name it.`;

async function generateDiagnosis(qaResult: QAResult, iteration: number): Promise<string> {
  const issuesSummary = qaResult.issues
    .map((i) => `[${i.severity.toUpperCase()}] ${i.taskId}: ${i.description}${i.file ? ` (${i.file})` : ''}`)
    .join('\n');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: DIAGNOSIS_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `Run ID: ${qaResult.runId}`,
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
  qaResult: QAResult,
  iteration: number,
  artifacts?: Artifact[]
): Promise<GateResult> {
  // Passed: emit go signal
  if (qaResult.passed) {
    return {
      runId,
      ciSignal: 'go',
      iteration,
      artifacts,
    };
  }

  // Has critical issues and iterations remain: send delta back to builder
  if (iteration < MAX_ITERATIONS) {
    // Prioritize the delta from QA; if empty, summarize critical issues
    const delta =
      qaResult.delta.trim() ||
      qaResult.issues
        .filter((i) => i.severity === 'critical' || i.severity === 'major')
        .map((i) => `- [${i.severity}] ${i.taskId}: ${i.description}`)
        .join('\n');

    return {
      runId,
      ciSignal: 'no-go',
      iteration,
      delta,
    };
  }

  // Exhausted retries: escalate with diagnosis
  const diagnosis = await generateDiagnosis(qaResult, iteration);
  return {
    runId,
    ciSignal: 'escalate',
    iteration,
    diagnosis,
  };
}
