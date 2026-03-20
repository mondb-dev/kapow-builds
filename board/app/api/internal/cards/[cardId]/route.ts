import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireInternalApiKey } from '@/lib/internal';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ cardId: string }> }
) {
  const unauthorized = requireInternalApiKey(req);
  if (unauthorized) return unauthorized;

  const { cardId } = await params;
  const body = await req.json();
  const { status } = body as { status?: string };

  const validStatuses = ['BACKLOG', 'IN_PROGRESS', 'QA', 'DONE', 'FAILED'];
  if (!status || !validStatuses.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${validStatuses.join(', ')}` },
      { status: 400 }
    );
  }

  const card = await db.card.update({
    where: { id: cardId },
    data: { status: status as 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED' },
  });

  return NextResponse.json(card);
}
