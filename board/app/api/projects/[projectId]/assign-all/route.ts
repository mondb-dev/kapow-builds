import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { triggerPipeline } from '@/lib/kapow';

interface Params {
  params: Promise<{ projectId: string }>;
}

export async function POST(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId } = await params;

  try {
    // Find all unassigned cards in this project
    const cards = await db.card.findMany({
      where: {
        projectId,
        assigneeType: 'UNASSIGNED',
      },
    });

    if (cards.length === 0) {
      return NextResponse.json({ error: 'No unassigned cards to assign' }, { status: 400 });
    }

    const results = [];

    for (const card of cards) {
      // Create a Run for each card
      const run = await db.run.create({
        data: {
          projectId,
          plan: card.description,
        },
      });

      // Update card
      await db.card.update({
        where: { id: card.id },
        data: {
          assigneeType: 'AGENT',
          assigneeId: null,
          status: 'IN_PROGRESS',
          runId: run.id,
        },
      });

      await db.cardEvent.create({
        data: {
          cardId: card.id,
          message: `Assigned to Kapow. Pipeline started. Run ID: ${run.id}`,
          type: 'INFO',
        },
      });

      // Fire pipeline (fire-and-forget)
      triggerPipeline(run.id, card.description).catch((err) => {
        console.error(`[assign-all] Pipeline trigger failed for card ${card.id}:`, err);
        db.cardEvent.create({
          data: {
            cardId: card.id,
            message: `Pipeline trigger failed: ${err instanceof Error ? err.message : String(err)}`,
            type: 'ERROR',
          },
        }).catch(() => {});
        db.card.update({
          where: { id: card.id },
          data: { status: 'FAILED' },
        }).catch(() => {});
      });

      results.push({ cardId: card.id, runId: run.id });
    }

    return NextResponse.json({
      assigned: results.length,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assign-all] Error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
