import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ cardId: string }>;
}

export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { cardId } = await params;

  // Verify card exists
  const card = await db.card.findUnique({ where: { id: cardId } });
  if (!card) {
    return new Response('Card not found', { status: 404 });
  }

  let lastSeenId: string | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(data: unknown) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      // Send initial heartbeat
      send({ type: 'connected', cardId });

      const poll = async () => {
        try {
          const where = lastSeenId
            ? { cardId, id: { gt: lastSeenId } }
            : { cardId };

          const events = await db.cardEvent.findMany({
            where,
            orderBy: { createdAt: 'asc' },
          });

          for (const event of events) {
            send(event);
            lastSeenId = event.id;
          }
        } catch {
          // DB error — send heartbeat to keep connection alive
          send({ type: 'heartbeat' });
        }
      };

      // Initial fetch
      await poll();

      // Poll every 2 seconds
      const interval = setInterval(async () => {
        if (req.signal.aborted) {
          clearInterval(interval);
          controller.close();
          return;
        }
        await poll();
      }, 2000);

      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
