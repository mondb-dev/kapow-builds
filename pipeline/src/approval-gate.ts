/**
 * Approval Gate
 *
 * Pauses a run after planning and asks the originating conversation to
 * approve the plan via the comms layer (TG inline buttons, Slack blocks,
 * etc.). If no conversation is attached to the run (e.g. board-initiated
 * runs), the gate is a no-op and the run continues automatically.
 */
import { prisma } from 'kapow-db';
import type { ProjectPlan, Phase } from 'kapow-shared';
import { getCommsBus } from './orchestrator.js';
import { requestApproval } from './comms-router.js';
import { stopRun } from './run-control.js';

export interface SprintTaskResult {
  taskId: string;
  description: string;
  passed: boolean;
  qaIterations: number;
  qaIssues: string[];
}

export interface PlanApprovalOutcome {
  approved: boolean;
  reason: string;
  revisionNotes?: string; // present when user clicked Revise with typed feedback
}

/**
 * If the run originated from a comms conversation, render the plan as a TG
 * approval prompt and block until the user clicks. Returns approved=true
 * for non-comms runs so existing board flows are unaffected.
 */
export async function maybeRequestPlanApproval(args: {
  runId: string;
  plan: ProjectPlan;
}): Promise<PlanApprovalOutcome> {
  const conv = await prisma.conversation.findFirst({
    where: { runId: args.runId },
  });
  if (!conv) {
    return { approved: true, reason: 'no-conversation' };
  }

  const summary = renderPlanSummary(args.plan);
  const reply = await requestApproval({
    commsBus: getCommsBus(),
    conversationId: conv.id,
    kind: 'plan_approval',
    text: summary,
    payload: {
      runId: args.runId,
      phaseCount: args.plan.phases.length,
      taskCount: args.plan.phases.reduce((n, p) => n + p.tasks.length, 0),
    },
  });

  if (reply.status === 'expired') {
    return { approved: false, reason: 'Approval timed out.' };
  }
  if (reply.status === 'cancelled') {
    return { approved: false, reason: 'Run cancelled during approval.' };
  }

  const newPhase = reply.choice === 'approve' ? 'building' : 'idle';
  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      phase: newPhase,
      messages: {
        push: {
          role: 'system',
          text: `plan_approval=${reply.choice} by ${reply.userName}`,
          at: reply.receivedAt.toISOString(),
        } as never,
      },
    },
  }).catch(() => undefined);

  if (reply.choice === 'approve') {
    return { approved: true, reason: 'approved' };
  }

  if (reply.choice === 'cancel') {
    stopRun(args.runId, 'User cancelled at plan approval.');
    await getCommsBus()?.notify('🛑 Cancelled. Type /new to start a new project.').catch(() => undefined);
    return { approved: false, reason: 'User cancelled.' };
  }

  // 'revise' — read any feedback the user typed before clicking the button
  const freshConv = await prisma.conversation.findUnique({ where: { id: conv.id } });
  type ConvMsg = { role: string; text: string; at: string };
  const stored = (freshConv?.messages ?? []) as ConvMsg[];
  const revisionNotes = stored
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
    .join('\n')
    .trim();

  if (revisionNotes) {
    await getCommsBus()?.notify('✏️ Got your feedback — replanning now…').catch(() => undefined);
    return { approved: false, reason: 'User requested revisions.', revisionNotes };
  }

  await getCommsBus()?.notify(
    '✏️ Plan revision requested.\n\nType your feedback and then send /resume N with your new direction to rebuild.',
  ).catch(() => undefined);
  return { approved: false, reason: 'User requested revisions.' };
}

function renderPlanSummary(plan: ProjectPlan): string {
  const taskCount = plan.phases.reduce((n, p) => n + p.tasks.length, 0);
  const phaseLines = plan.phases.slice(0, 8).map((p, i) => {
    const tasks = p.tasks.slice(0, 5).map((t) => `   • ${escape(t.description.slice(0, 200))}`).join('\n');
    const more = p.tasks.length > 5 ? `\n   <i>…+${p.tasks.length - 5} more</i>` : '';
    return `<b>${i + 1}. ${escape(p.name)}</b>\n${tasks}${more}`;
  }).join('\n\n');

  const overview = plan.architecture?.overview
    ? `\n<i>${escape(plan.architecture.overview.slice(0, 240))}</i>\n`
    : '';

  return [
    `📋 <b>Sprint plan ready</b> — ${plan.phases.length} phases, ${taskCount} tasks`,
    overview,
    phaseLines,
    '',
    'Approve to start building, Revise to refine, Cancel to stop.',
  ].join('\n');
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function maybeRequestSprintReview(args: {
  runId: string;
  sprintIndex: number;
  phase: Phase;
  nextPhase: Phase;
  taskResults: SprintTaskResult[];
}): Promise<PlanApprovalOutcome> {
  const conv = await prisma.conversation.findFirst({ where: { runId: args.runId } });
  if (!conv) return { approved: true, reason: 'no-conversation' };

  const text = renderSprintReport(args.sprintIndex, args.phase, args.nextPhase, args.taskResults);

  const reply = await requestApproval({
    commsBus: getCommsBus(),
    conversationId: conv.id,
    kind: 'sprint_review',
    text,
    payload: { runId: args.runId, sprintIndex: args.sprintIndex },
    buttons: [
      { id: 'approve', label: '▶️ Continue to next sprint', style: 'primary' },
      { id: 'cancel', label: '⏹ Stop here', style: 'danger' },
    ],
  });

  if (reply.status === 'expired') return { approved: false, reason: 'Sprint review timed out.' };
  if (reply.status === 'cancelled') return { approved: false, reason: 'Run cancelled during sprint review.' };
  if (reply.choice === 'approve') return { approved: true, reason: 'approved' };
  stopRun(args.runId, 'User stopped after sprint review.');
  return { approved: false, reason: 'User stopped after sprint review.' };
}

function renderSprintReport(
  sprintIndex: number,
  phase: Phase,
  nextPhase: Phase,
  taskResults: SprintTaskResult[],
): string {
  const passed = taskResults.filter((t) => t.passed);
  const failed = taskResults.filter((t) => !t.passed);
  const totalIterations = taskResults.reduce((n, t) => n + t.qaIterations, 0);

  const taskLines = taskResults.map((t) => {
    const icon = t.passed ? '✅' : '❌';
    const issues = t.qaIssues.length > 0
      ? '\n' + t.qaIssues.slice(0, 3).map((i) => `     ⚠️ ${escape(i.slice(0, 120))}`).join('\n')
      : '';
    const iters = t.qaIterations > 1 ? ` <i>(${t.qaIterations} QA iterations)</i>` : '';
    return `${icon} ${escape(t.description.slice(0, 160))}${iters}${issues}`;
  }).join('\n');

  const fixNote = totalIterations > taskResults.length
    ? `\n<i>🔧 ${totalIterations - taskResults.length} QA fix${totalIterations - taskResults.length > 1 ? 'es' : ''} applied during this sprint</i>`
    : '';

  return [
    `🏁 <b>Sprint ${sprintIndex + 1} complete</b> — ${escape(phase.name)}`,
    '',
    `Tasks: ${passed.length} ✅ passed${failed.length > 0 ? `, ${failed.length} ❌ failed` : ''}`,
    fixNote,
    '',
    '<b>Test Report:</b>',
    taskLines,
    '',
    `<b>Up next:</b> Sprint ${sprintIndex + 2} — ${escape(nextPhase.name)}`,
    escape(nextPhase.description?.slice(0, 200) ?? ''),
  ].filter((l) => l !== null).join('\n');
}
