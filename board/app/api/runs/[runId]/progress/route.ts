import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const KAPOW_URL = process.env.KAPOW_ACTIONS_URL ?? 'http://localhost:3000';

interface Params {
  params: Promise<{ runId: string }>;
}

export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { runId } = await params;

  // Find the card associated with this runId
  const card = await db.card.findFirst({ where: { runId } });
  if (!card) {
    return new Response('No card found for this runId', { status: 404 });
  }

  const cardId = card.id;
  let lastMessageCount = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(data: unknown) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      send({ type: 'connected', runId });

      const poll = async () => {
        try {
          const res = await fetch(`${KAPOW_URL}/runs/${runId}/status`, {
            signal: AbortSignal.timeout(5000),
          });

          if (!res.ok) {
            send({ type: 'error', message: `kapow-actions returned ${res.status}` });
            return;
          }

          const data = (await res.json()) as { status: string; messages: unknown };

          // Validate that messages is an array of strings
          const messages: string[] = Array.isArray(data.messages)
            ? data.messages.filter((m): m is string => typeof m === 'string')
            : [];

          // Only write new messages as CardEvents
          const newMessages = messages.slice(lastMessageCount);
          lastMessageCount = messages.length;

          for (const msg of newMessages) {
            const eventType =
              data.status === 'failed' ? 'ERROR' :
              msg.toLowerCase().includes('complete') ? 'SUCCESS' : 'PROGRESS';

            const event = await db.cardEvent.create({
              data: {
                cardId,
                message: msg,
                type: eventType,
              },
            });

            send(event);
          }

          // Update card status when pipeline finishes
          if (data.status === 'done') {
            await db.card.update({
              where: { id: cardId },
              data: { status: 'QA' },
            });
            send({ type: 'done', runId });
          } else if (data.status === 'failed') {
            await db.card.update({
              where: { id: cardId },
              data: { status: 'FAILED' },
            });
            send({ type: 'failed', runId });
          }

          // Stop polling when terminal state reached
          if (data.status === 'done' || data.status === 'failed') {
            controller.close();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send({ type: 'error', message: `Poll error: ${msg}` });
        }
      };

      await poll();

      const interval = setInterval(async () => {
        if (req.signal.aborted) {
          clearInterval(interval);
          controller.close();
          return;
        }
        await poll();
      }, 3000);

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
