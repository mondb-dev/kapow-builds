/**
 * Sprint Retrospective Agent
 *
 * After all agile sprints complete, analyzes velocity and QA patterns,
 * produces a retrospective.md, and extracts a recipe so future runs benefit.
 * Grounded in the research finding that data-driven retrospectives surface
 * patterns that subjective team discussion misses.
 */
import { getAI } from 'kapow-shared';
import { writeFileSync } from 'fs';
import { join } from 'path';
import type { SprintTaskResult } from '../approval-gate.js';
import type { Phase } from 'kapow-shared';

const { provider, models } = getAI();

export interface SprintSummary {
  sprintIndex: number;
  phase: Phase;
  taskResults: SprintTaskResult[];
}

export interface RetrospectiveResult {
  markdown: string;
  recipeName: string;
  recipeContent: string;
}

const RETRO_PROMPT = `You are an experienced Scrum Master running a sprint retrospective.
You have objective data from all sprints — velocity, QA iterations, failure patterns.
Your job: produce a concise, honest, actionable retrospective.

Structure your output as:

## Sprint Velocity
Table: Sprint | Planned | Completed | Failed | QA Fixes

## What Went Well
- Specific, evidence-backed observations (not generic praise)

## What Slowed Us Down
- Patterns in QA failures, recurring fix types, tasks that needed multiple iterations

## Process Improvements
- Concrete, actionable changes for the next run (not vague suggestions)
  Format: "When X happens, do Y instead of Z"

## Recipe Extract
A single paragraph (max 5 sentences) summarising the most important lesson from this run.
This will be saved as a recipe to improve future planning. Start with: "RECIPE: "

Be specific. Reference actual task IDs and sprint names where relevant.
Do not pad with filler. If all sprints went smoothly, say so and explain why.`;

export async function runRetrospective(
  runId: string,
  brief: string,
  sprints: SprintSummary[],
  sandboxPath: string,
): Promise<RetrospectiveResult> {
  const sprintData = sprints.map((s) => {
    const planned = s.taskResults.length;
    const completed = s.taskResults.filter((t) => t.passed).length;
    const failed = s.taskResults.filter((t) => !t.passed).length;
    const totalQAIterations = s.taskResults.reduce((n, t) => n + t.qaIterations, 0);
    const fixes = totalQAIterations - planned;
    const issues = s.taskResults.flatMap((t) =>
      t.qaIssues.map((i) => `  [${t.taskId}] ${i}`)
    );

    return [
      `Sprint ${s.sprintIndex + 1}: ${s.phase.name}`,
      `  Goal: ${s.phase.description ?? '(none)'}`,
      `  Planned: ${planned} | Completed: ${completed} | Failed: ${failed} | QA fixes: ${fixes}`,
      ...(issues.length > 0 ? [`  Issues:\n${issues.join('\n')}`] : []),
    ].join('\n');
  }).join('\n\n');

  const prompt = [
    `Project brief: ${brief}`,
    `Run ID: ${runId}`,
    '',
    '=== SPRINT DATA ===',
    sprintData,
    '=== END SPRINT DATA ===',
    '',
    RETRO_PROMPT,
  ].join('\n');

  let markdown = '';
  try {
    const response = await provider.chat({
      model: models.strong,
      maxTokens: 4096,
      system: 'You are an experienced Scrum Master running a data-driven retrospective.',
      messages: [{ role: 'user', content: prompt }],
    });
    markdown = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('\n')
      .trim();
  } catch {
    markdown = `# Retrospective\n\n*Retrospective generation failed — raw sprint data below.*\n\n\`\`\`\n${sprintData}\n\`\`\``;
  }

  // Write to sandbox
  const retroPath = join(sandboxPath, 'retrospective.md');
  writeFileSync(retroPath, `# Sprint Retrospective — Run ${runId}\n\n${markdown}\n`);

  // Extract the recipe paragraph
  const recipeMatch = markdown.match(/RECIPE:\s*([\s\S]+?)(?:\n##|$)/);
  const recipeContent = recipeMatch
    ? recipeMatch[1].trim()
    : `Agile run for: ${brief.slice(0, 100)}. ${sprints.length} sprints completed.`;

  const totalTasks = sprints.reduce((n, s) => n + s.taskResults.length, 0);
  const totalPassed = sprints.reduce((n, s) => n + s.taskResults.filter((t) => t.passed).length, 0);
  const recipeName = `Agile retrospective: ${brief.slice(0, 60)} (${totalPassed}/${totalTasks} tasks passed)`;

  return { markdown, recipeName, recipeContent };
}
