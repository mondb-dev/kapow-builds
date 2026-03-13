import Anthropic from '@anthropic-ai/sdk';
import { MAX_ITERATIONS, type QAResult, type GateResult, type Artifact } from './types.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DIAGNOSIS_SYSTEM_PROMPT = `You are a CI/CD gate engineer writing a final failure diagnosis report.

The build pipeline has failed all ${MAX_ITERATIONS} retry attempts. Your job is to write a clear,
concise diagnosis that explains:
1. What the original plan was trying to achieve
2. What specifically failed and why (based on the QA issues)
3. What a developer would need to do differently to succeed
4. Whether the plan itself had fundamental issues, or whether it was an implementation problem

Write in plain prose, 2-4 paragraphs. Be direct and technical. No markdown headers.`;

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
