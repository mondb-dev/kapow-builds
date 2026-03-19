import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * Internal API — no auth required (service-to-service from kapow-actions).
 * Protected by network isolation (only accessible within Docker network or localhost).
 */

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { title, description, status, runId, phaseId, taskId } = body as {
    title?: string;
    description?: string;
    status?: string;
    runId?: string;
    phaseId?: string;
    taskId?: string;
  };

  if (!title?.trim() || !description?.trim()) {
    return NextResponse.json({ error: 'title and description are required' }, { status: 400 });
  }

  if (title.trim().length > 200 || description.trim().length > 50000) {
    return NextResponse.json({ error: 'title max 200, description max 50000 chars' }, { status: 400 });
  }

  const validStatuses = ['BACKLOG', 'IN_PROGRESS', 'QA', 'DONE', 'FAILED'];
  const cardStatus = status && validStatuses.includes(status) ? status : 'BACKLOG';

  const card = await db.card.create({
    data: {
      title: title.trim(),
      description: description.trim(),
      status: cardStatus as 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED',
      assigneeType: 'AGENT',
      runId: runId ?? null,
      phaseId: phaseId ?? null,
      taskId: taskId ?? null,
    },
  });

  return NextResponse.json(card, { status: 201 });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const runId = searchParams.get('runId');

  if (!runId) {
    return NextResponse.json({ error: 'runId query param is required' }, { status: 400 });
  }

  const cards = await db.card.findMany({
    where: { runId },
    include: { events: { orderBy: { createdAt: 'desc' }, take: 10 } },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({ cards });
}
