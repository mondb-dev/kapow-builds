/**
 * Approval Gate
 *
 * Pauses a run after planning and asks the originating conversation to
 * approve the plan via the comms layer (TG inline buttons, Slack blocks,
 * etc.). If no conversation is attached to the run (e.g. board-initiated
 * runs), the gate is a no-op and the run continues automatically.
 */
import { prisma } from 'kapow-db';
import type { ProjectPlan } from 'kapow-shared';
import { getCommsBus } from './orchestrator.js';
import { requestApproval } from './comms-router.js';
import { stopRun } from './run-control.js';

export interface PlanApprovalOutcome {
  approved: boolean;
  reason: string;
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

  // Persist the decision on the conversation row (Approval table is a follow-up).
  if (reply.status === 'answered') {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        phase: reply.choice === 'approve' ? 'building' : 'failed',
        messages: {
          push: {
            role: 'system',
            text: `plan_approval=${reply.choice} by ${reply.userName}`,
            at: reply.receivedAt.toISOString(),
          } as never,
        },
      },
    }).catch(() => undefined);
  }

  if (reply.status === 'expired') {
    return { approved: false, reason: 'Approval timed out.' };
  }
  if (reply.status === 'cancelled') {
    return { approved: false, reason: 'Run cancelled during approval.' };
  }
  if (reply.choice === 'approve') {
    return { approved: true, reason: 'approved' };
  }
  if (reply.choice === 'cancel') {
    stopRun(args.runId, 'User cancelled at plan approval.');
    return { approved: false, reason: 'User cancelled.' };
  }
  // 'revise' or anything else
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
