/**
 * Bus HTTP API
 *
 * Runs alongside the actions HTTP server. Agents connect here
 * to publish, subscribe (poll), and send request/reply messages.
 *
 * Endpoints:
 *   POST /bus/publish     — publish a message
 *   POST /bus/request     — request/reply (blocks until reply or timeout)
 *   GET  /bus/messages    — poll for new messages (filtered by agent + after ID)
 *   GET  /bus/status      — bus stats
 */
import express, { Request, Response } from 'express';
import { getBus } from 'kapow-shared';
import type { BusMessage } from 'kapow-shared';

const bus = getBus();

// Track messages per agent for polling
const agentInboxes = new Map<string, BusMessage[]>();
const MAX_INBOX_SIZE = 500;

// Subscribe to all topics to route to agent inboxes
bus.subscribe('*', (msg) => {
  // If directed, only put in the target agent's inbox
  if (msg.to) {
    pushToInbox(msg.to, msg);
  } else {
    // Broadcast to all known agents
    for (const [agent] of agentInboxes) {
      if (agent !== msg.from) { // Don't echo back to sender
        pushToInbox(agent, msg);
      }
    }
  }
});

function pushToInbox(agent: string, msg: BusMessage): void {
  if (!agentInboxes.has(agent)) agentInboxes.set(agent, []);
  const inbox = agentInboxes.get(agent)!;
  inbox.push(msg);
  if (inbox.length > MAX_INBOX_SIZE) inbox.splice(0, inbox.length - MAX_INBOX_SIZE);
}

function ensureAgent(agent: string): void {
  if (!agentInboxes.has(agent)) agentInboxes.set(agent, []);
}

export function mountBusAPI(app: express.Express): void {
  // ── Publish ────────────────────────────────────────────────────

  app.post('/bus/publish', async (req: Request, res: Response) => {
    const { topic, from, to, type, payload, runId, attachments } = req.body;

    if (!topic || !from) {
      res.status(400).json({ error: 'topic and from are required' });
      return;
    }

    ensureAgent(from);

    await bus.publish({
      topic,
      from,
      to,
      type: type ?? 'event',
      payload: payload ?? {},
      runId,
      attachments,
    });

    res.json({ ok: true });
  });

  // ── Request/Reply ──────────────────────────────────────────────

  app.post('/bus/request', async (req: Request, res: Response) => {
    const { topic, from, to, payload, runId } = req.body;

    if (!topic || !from || !to) {
      res.status(400).json({ error: 'topic, from, and to are required' });
      return;
    }

    ensureAgent(from);

    try {
      const reply = await bus.request(
        { topic, from, to, payload: payload ?? {}, runId },
        30_000,
      );
      res.json(reply);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(408).json({ error: msg });
    }
  });

  // ── Poll Messages ──────────────────────────────────────────────

  app.get('/bus/messages', (req: Request, res: Response) => {
    const agent = req.query.agent as string;
    const afterId = req.query.after as string | undefined;

    if (!agent) {
      res.status(400).json({ error: 'agent query param is required' });
      return;
    }

    ensureAgent(agent);
    const inbox = agentInboxes.get(agent) ?? [];

    let messages: BusMessage[];
    if (afterId) {
      const idx = inbox.findIndex((m) => m.id === afterId);
      messages = idx >= 0 ? inbox.slice(idx + 1) : inbox;
    } else {
      messages = inbox;
    }

    // Clear delivered messages
    if (messages.length > 0) {
      agentInboxes.set(agent, []);
    }

    res.json(messages);
  });

  // ── Status ─────────────────────────────────────────────────────

  app.get('/bus/status', (_req: Request, res: Response) => {
    res.json({
      subscriptions: bus.getSubscriptionCount(),
      agents: Array.from(agentInboxes.keys()),
      recentMessages: bus.getRecentMessages(10),
    });
  });
}
