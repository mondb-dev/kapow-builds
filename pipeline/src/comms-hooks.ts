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
    async startProject({ brief, conversationId, requestedBy, preferences }) {
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
      }, project.id, preferences).catch((err) => {
        console.error(`[run ${run.id}] failed:`, err instanceof Error ? err.message : err);
      });

      console.log(`[hooks] Started run ${run.id} for ${requestedBy.userName} (conv ${conversationId})`);
      return { projectId: project.id, runId: run.id };
    },

    async listProjects() {
      const projects = await prisma.project.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 20,
        include: {
          runs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, createdAt: true, planData: true },
          },
        },
      });

      if (projects.length === 0) return 'No projects yet. Use /new to start one.';

      const lines = projects.map((p, i) => {
        const run = p.runs[0];
        const status = run ? run.status.toLowerCase() : 'no runs';
        const icon = status === 'done' ? '✅' : status === 'failed' ? '❌' : status === 'building' ? '🔨' : '📋';
        const arch = run?.planData as { architecture?: { approach?: string } } | null;
        const stack = arch?.architecture?.approach?.slice(0, 60) ?? '';
        const age = run ? timeSince(run.createdAt) : '';
        return `${i + 1}. ${icon} <b>${escape(p.name)}</b>${age ? ` — ${age}` : ''}${stack ? `\n   <i>${escape(stack)}</i>` : ''}${p.repoUrl ? `\n   🔗 ${escape(p.repoUrl)}` : ''}`;
      });

      return `<b>Projects (${projects.length})</b>\n\n${lines.join('\n\n')}\n\nUse /resume &lt;number&gt; &lt;direction&gt; to update a project.`;
    },

    async resumeProject({ projectId: indexStr, direction, conversationId, requestedBy }) {
      const index = parseInt(indexStr, 10);
      const projects = await prisma.project.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 20,
        include: {
          runs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { plan: true, planData: true },
          },
        },
      });

      const project = projects[index];
      if (!project) throw new Error(`No project at position ${index + 1}. Use /projects to see the list.`);

      const lastRun = project.runs[0];
      const arch = lastRun?.planData as { architecture?: { approach?: string; structure?: string; conventions?: string } } | null;

      const preferences = [
        `Resuming project: ${project.name}`,
        project.repoUrl ? `GitHub repo URL: ${project.repoUrl}` : '',
        arch?.architecture?.approach ? `Original tech stack: ${arch.architecture.approach}` : '',
        arch?.architecture?.structure ? `Original structure: ${arch.architecture.structure}` : '',
        arch?.architecture?.conventions ? `Conventions: ${arch.architecture.conventions}` : '',
        `Original brief: ${lastRun?.plan?.slice(0, 300) ?? project.description ?? ''}`,
      ].filter(Boolean).join('\n');

      const run = await prisma.run.create({
        data: { projectId: project.id, plan: direction, status: 'PENDING' },
      });

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { projectId: project.id, runId: run.id },
      });

      void runPipeline(run.id, direction, (line) => {
        console.log(`[run ${run.id}] ${line}`);
      }, project.id, preferences).catch((err) => {
        console.error(`[run ${run.id}] resume failed:`, err instanceof Error ? err.message : err);
      });

      console.log(`[hooks] Resumed project "${project.name}" (run ${run.id}) for ${requestedBy.userName}`);
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

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeSince(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
