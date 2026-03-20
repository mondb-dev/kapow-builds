import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { triggerPipeline } from '@/lib/kapow';
import { userCanAccessCard } from '@/lib/authz';

interface Params {
  params: Promise<{ cardId: string }>;
}

// Background fire-and-forget: runs pipeline, writes progress events to DB
async function runPipelineBackground(cardId: string, runId: string, plan: string, projectId?: string) {
  try {
    await triggerPipeline(runId, plan, projectId);
    // kapow-actions is async — progress comes via SSE /runs/:runId/stream
    // which the progress route will relay and persist as CardEvents
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.cardEvent.create({
      data: {
        cardId,
        message: `Pipeline trigger failed: ${msg}`,
        type: 'ERROR',
      },
    });
    await db.card.update({
      where: { id: cardId },
      data: { status: 'FAILED' },
    });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { cardId } = await params;
  const body = await req.json();
  const { assigneeType, userId } = body as { assigneeType: 'AGENT' | 'HUMAN'; userId?: string };

  const card = await db.card.findUnique({ where: { id: cardId } });
  if (!card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 });
  }

  if (!(await userCanAccessCard(session.user.id, cardId)) && !session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (assigneeType === 'AGENT') {
    // Ensure card has a project (create default if needed)
    let projectId = card.projectId;
    if (!projectId) {
      const project = await db.project.create({
        data: {
          name: card.title,
          members: { connect: { id: session.user.id } },
        },
      });
      projectId = project.id;
      await db.card.update({ where: { id: cardId }, data: { projectId } });
    }

    // Create a Run record (Card.runId is a FK to Run)
    const run = await db.run.create({
      data: {
        projectId,
        plan: card.description,
      },
    });

    await db.card.update({
      where: { id: cardId },
      data: {
        assigneeType: 'AGENT',
        assigneeId: null,
        status: 'IN_PROGRESS',
        runId: run.id,
      },
    });

    const runId = run.id;

    const updated = await db.card.findUnique({
      where: { id: cardId },
      include: {
        assignee: { select: { id: true, name: true, image: true } },
        creator: { select: { id: true, name: true, image: true } },
      },
    });

    await db.cardEvent.create({
      data: {
        cardId,
        message: `Assigned to Kapow Agent. Pipeline started. Run ID: ${runId}`,
        type: 'INFO',
      },
    });

    // Fire and forget — do not block the response
    void runPipelineBackground(cardId, runId, card.description, projectId);

    return NextResponse.json(updated);
  }

  if (assigneeType === 'HUMAN') {
    const targetUserId = userId ?? session.user.id;

    const user = await db.user.findUnique({ where: { id: targetUserId } });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    await db.card.update({
      where: { id: cardId },
      data: {
        assigneeType: 'HUMAN',
        assigneeId: targetUserId,
      },
    });

    const updated = await db.card.findUnique({
      where: { id: cardId },
      include: {
        assignee: { select: { id: true, name: true, image: true } },
        creator: { select: { id: true, name: true, image: true } },
      },
    });

    await db.cardEvent.create({
      data: {
        cardId,
        message: `Assigned to ${user.name ?? user.email}.`,
        type: 'INFO',
      },
    });

    return NextResponse.json(updated);
  }

  return NextResponse.json({ error: 'assigneeType must be AGENT or HUMAN' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assign] Error:', msg, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
