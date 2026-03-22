import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireInternalApiKey } from '@/lib/internal';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ cardId: string }> }
) {
  const unauthorized = requireInternalApiKey(req);
  if (unauthorized) return unauthorized;

  const { cardId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
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
