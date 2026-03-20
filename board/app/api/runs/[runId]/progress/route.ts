import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getInternalAuthHeaders } from '@/lib/internal';
import { userCanAccessRun } from '@/lib/authz';

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

  if (!(await userCanAccessRun(session.user.id, runId)) && !session.user.isAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const card = await db.card.findFirst({ where: { runId } });
  if (!card) {
    return new Response('No card found for this runId', { status: 404 });
  }

  const cardId = card.id;

  // Use existing event count as the watermark — prevents duplication on reconnect
  const existingEventCount = await db.cardEvent.count({ where: { cardId } });
  let lastMessageCount = existingEventCount;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(data: unknown) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      send({ type: 'connected', runId });

      // Send existing events to this viewer (read-only, no duplication)
      const existingEvents = await db.cardEvent.findMany({
        where: { cardId },
        orderBy: { createdAt: 'asc' },
      });
      for (const event of existingEvents) {
        send(event);
      }

      const poll = async () => {
        try {
          const res = await fetch(`${KAPOW_URL}/runs/${runId}/status`, {
            headers: getInternalAuthHeaders(),
            signal: AbortSignal.timeout(5000),
          });

          if (!res.ok) {
            send({ type: 'error', message: `kapow-actions returned ${res.status}` });
            return;
          }

          const data = (await res.json()) as { status: string; messages: unknown };

          const messages: string[] = Array.isArray(data.messages)
            ? data.messages.filter((m): m is string => typeof m === 'string')
            : [];

          // Only create events for messages we haven't persisted yet
          const newMessages = messages.slice(lastMessageCount);
          if (newMessages.length > 0) {
            lastMessageCount = messages.length;

            for (const msg of newMessages) {
              // Deduplicate: check if this exact message already exists for this card
              const exists = await db.cardEvent.findFirst({
                where: { cardId, message: msg },
              });
              if (exists) {
                send(exists); // Send to viewer but don't re-create
                continue;
              }

              const eventType =
                data.status === 'failed' ? 'ERROR' as const :
                msg.toLowerCase().includes('complete') ? 'SUCCESS' as const : 'PROGRESS' as const;

              const event = await db.cardEvent.create({
                data: { cardId, message: msg, type: eventType },
              });
              send(event);
            }
          }

          if (data.status === 'done') {
            await db.card.update({ where: { id: cardId }, data: { status: 'QA' } });
            send({ type: 'done', runId });
          } else if (data.status === 'failed') {
            await db.card.update({ where: { id: cardId }, data: { status: 'FAILED' } });
            send({ type: 'failed', runId });
          }

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
