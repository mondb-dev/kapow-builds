import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * Internal API — add events to a card (service-to-service).
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ cardId: string }> }
) {
  const { cardId } = await params;
  const body = await req.json();
  const { message, type } = body as { message?: string; type?: string };

  if (!message?.trim()) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const validTypes = ['INFO', 'SUCCESS', 'ERROR', 'PROGRESS'];
  const eventType = type && validTypes.includes(type) ? type : 'INFO';

  const event = await db.cardEvent.create({
    data: {
      cardId,
      message: message.trim().slice(0, 5000),
      type: eventType as 'INFO' | 'SUCCESS' | 'ERROR' | 'PROGRESS',
    },
  });

  return NextResponse.json(event, { status: 201 });
}
