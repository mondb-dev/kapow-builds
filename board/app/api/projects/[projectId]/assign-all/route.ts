import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { triggerPipeline } from '@/lib/kapow';
import { userCanAccessProject } from '@/lib/authz';

interface Params {
  params: Promise<{ projectId: string }>;
}

function getProjectBrief(description: string | null | undefined): string {
  if (!description) return '';
  const [brief] = description.split('\n--- Architecture ---\n');
  return brief.trim();
}

export async function POST(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId } = await params;

  if (!(await userCanAccessProject(session.user.id, projectId)) && !session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, description: true, planData: true },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const brief = getProjectBrief(project.description);
    if (!brief) {
      return NextResponse.json({ error: 'Project brief is missing' }, { status: 400 });
    }

    const activeRunCard = await db.card.findFirst({
      where: {
        projectId,
        runId: { not: null },
        status: { in: ['BACKLOG', 'IN_PROGRESS', 'QA'] },
      },
      select: { runId: true },
    });

    if (activeRunCard?.runId) {
      return NextResponse.json({
        error: `Project already has active work in run ${activeRunCard.runId}`,
      }, { status: 400 });
    }

    // Find planner-generated cards that have not started yet.
    const cards = await db.card.findMany({
      where: {
        projectId,
        assigneeType: 'UNASSIGNED',
        runId: null,
        phaseId: { not: null },
        taskId: { not: null },
      },
      select: { id: true, title: true },
    });

    if (cards.length === 0) {
      return NextResponse.json({ error: 'No planned cards ready to start' }, { status: 400 });
    }

    const run = await db.run.create({
      data: {
        projectId,
        plan: brief,
        planData: project.planData ?? undefined,
      },
    });

    await db.card.updateMany({
      where: { id: { in: cards.map((card) => card.id) } },
      data: {
        assigneeType: 'AGENT',
        assigneeId: null,
        status: 'BACKLOG',
        runId: run.id,
      },
    });

    await db.cardEvent.createMany({
      data: cards.map((card) => ({
        cardId: card.id,
        message: `Queued for Kapow project run ${run.id}. Work will follow the planner sequence.`,
        type: 'INFO' as const,
      })),
    });

    triggerPipeline(run.id, brief, projectId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[assign-all] Project run trigger failed for ${projectId}:`, err);
      db.cardEvent.createMany({
        data: cards.map((card) => ({
          cardId: card.id,
          message: `Pipeline trigger failed: ${message}`,
          type: 'ERROR' as const,
        })),
      }).catch(() => {});
      db.card.updateMany({
        where: { id: { in: cards.map((card) => card.id) } },
        data: { status: 'FAILED' },
      }).catch(() => {});
    });

    return NextResponse.json({
      started: cards.length,
      runId: run.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assign-all] Error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
