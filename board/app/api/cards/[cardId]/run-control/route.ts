import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { stopPipeline, triggerPipeline } from '@/lib/kapow';
import { userCanAccessCard } from '@/lib/authz';

interface Params {
  params: Promise<{ cardId: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { cardId } = await params;
  if (!(await userCanAccessCard(session.user.id, cardId)) && !session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const action = body?.action as 'stop' | 'restart' | undefined;
  if (action !== 'stop' && action !== 'restart') {
    return NextResponse.json({ error: 'action must be stop or restart' }, { status: 400 });
  }

  const card = await db.card.findUnique({
    where: { id: cardId },
    include: { run: true },
  });

  if (!card?.runId || !card.run) {
    return NextResponse.json({ error: 'Card is not attached to a run' }, { status: 400 });
  }

  const relatedCards = await db.card.findMany({
    where: { runId: card.runId },
    select: { id: true },
  });

  if (action === 'stop') {
    await stopPipeline(card.runId, `Stopped by ${session.user.name ?? 'user'}.`);

    if (relatedCards.length > 0) {
      await db.card.updateMany({
        where: {
          id: { in: relatedCards.map((item) => item.id) },
          status: { in: ['BACKLOG', 'IN_PROGRESS', 'QA'] },
        },
        data: { status: 'FAILED' },
      });
      await db.cardEvent.createMany({
        data: relatedCards.map((item) => ({
          cardId: item.id,
          message: `Run stopped by ${session.user.name ?? 'user'}.`,
          type: 'ERROR' as const,
        })),
      });
    }

    return NextResponse.json({ ok: true, action });
  }

  await stopPipeline(card.runId, `Restart requested by ${session.user.name ?? 'user'}.`).catch(() => {});

  if (relatedCards.length > 0) {
    await db.card.updateMany({
      where: { id: { in: relatedCards.map((item) => item.id) } },
      data: { status: 'BACKLOG' },
    });
    await db.cardEvent.createMany({
      data: relatedCards.map((item) => ({
        cardId: item.id,
        message: `Run restarted by ${session.user.name ?? 'user'}.`,
        type: 'INFO' as const,
      })),
    });
  }

  await triggerPipeline(card.runId, card.run.plan, card.run.projectId);

  return NextResponse.json({ ok: true, action, runId: card.runId });
}
