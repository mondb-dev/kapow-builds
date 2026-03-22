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
  const { status, output } = body as { status?: string; output?: unknown };

  const data: Record<string, unknown> = {};

  if (status) {
    const validStatuses = ['BACKLOG', 'IN_PROGRESS', 'QA', 'DONE', 'FAILED'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      );
    }
    data.status = status;
  }

  if (output !== undefined) {
    data.output = output;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  try {
    const card = await db.card.update({
      where: { id: cardId },
      data,
    });
    return NextResponse.json(card);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[internal/cards/${cardId}] PATCH failed:`, msg);
    // If output caused the error, retry without it
    if (output !== undefined && status) {
      try {
        const card = await db.card.update({
          where: { id: cardId },
          data: { status },
        });
        console.error(`[internal/cards/${cardId}] Retried without output — status updated to ${status}`);
        return NextResponse.json(card);
      } catch { /* fall through */ }
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
