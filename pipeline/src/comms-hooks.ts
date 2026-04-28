/**
 * Comms Hooks
 *
 * Bridges the CommsRouter (inbound TG/Slack) to the pipeline orchestrator.
 * Kept as a separate file so the orchestrator can stay focused on running
 * agents — this file owns conversation-driven entry points.
 *
 * For v1 the hooks delegate to runPipeline() in a fire-and-forget manner;
 * the router is responsible for replying with status updates via CommsBus
 * events. A more sophisticated implementation can wire run progress back
 * onto the originating thread by passing conversationId through onProgress.
 */
import { prisma } from 'kapow-db';
import { runPipeline } from './orchestrator.js';
import { stopRun } from './run-control.js';
import type { OrchestratorHooks } from './comms-router.js';

export function createOrchestratorHooks(): OrchestratorHooks {
  return {
    async startProject({ brief, conversationId, requestedBy }) {
      // Create a Project + Run; runPipeline owns planning and beyond.
      const project = await prisma.project.create({
        data: {
          name: deriveProjectName(brief),
          description: brief,
        },
      });
      const run = await prisma.run.create({
        data: {
          projectId: project.id,
          plan: brief,
          status: 'PENDING',
        },
      });

      // Link conversation to run BEFORE firing pipeline so approval gate can find it.
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { projectId: project.id, runId: run.id },
      });

      // Fire-and-forget; progress streams back through CommsBus events.
      void runPipeline(run.id, brief, (line) => {
        console.log(`[run ${run.id}] ${line}`);
      }, project.id).catch((err) => {
        console.error(`[run ${run.id}] failed:`, err instanceof Error ? err.message : err);
      });

      console.log(`[hooks] Started run ${run.id} for ${requestedBy.userName} (conv ${conversationId})`);
      return { projectId: project.id, runId: run.id };
    },

    async cancelRun(runId) {
      const stopped = stopRun(runId, 'Cancelled via comms.');
      if (!stopped) {
        // Run wasn't active in memory — flip DB status anyway to prevent resume.
        await prisma.run.update({
          where: { id: runId },
          data: { status: 'FAILED' },
        }).catch(() => undefined);
      }
    },

    async describeStatus({ conversationId }) {
      const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conv) return 'No active conversation.';
      if (!conv.runId) return `Phase: ${conv.phase}. No run started.`;
      const run = await prisma.run.findUnique({
        where: { id: conv.runId },
        include: {
          cards: { select: { status: true } },
        },
      });
      if (!run) return `Run ${conv.runId} not found.`;
      const counts = run.cards.reduce<Record<string, number>>((acc, c) => {
        acc[c.status] = (acc[c.status] ?? 0) + 1;
        return acc;
      }, {});
      const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' • ') || 'no cards yet';
      return `Run ${run.id} — ${run.status}\nPhase: ${conv.phase}\nCards: ${summary}`;
    },
  };
}

function deriveProjectName(brief: string): string {
  const firstLine = brief.split('\n')[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine || 'Untitled';
}
