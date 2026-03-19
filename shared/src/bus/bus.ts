/**
 * Message Bus Implementation
 *
 * In-process event router with HTTP bridge for cross-service messaging.
 * Each agent connects via HTTP SSE (subscribe) and POST (publish).
 *
 * Architecture:
 * - The bus runs inside the actions/orchestrator process
 * - Agents connect via HTTP to subscribe and publish
 * - Messages are routed by topic and optional target agent
 * - Request/reply uses correlation IDs with timeout
 */
import { randomUUID } from 'crypto';
import type { BusMessage, MessageHandler, Subscription, FileAttachment } from './types.js';

export class MessageBus {
  private subscriptions: Subscription[] = [];
  private pendingReplies = new Map<string, {
    resolve: (msg: BusMessage) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private messageLog: BusMessage[] = [];
  private maxLogSize = 1000;

  // ── Publish (broadcast or directed) ──────────────────────────────

  async publish(msg: Omit<BusMessage, 'id' | 'timestamp'>): Promise<void> {
    const full: BusMessage = {
      ...msg,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };

    // Log
    this.messageLog.push(full);
    if (this.messageLog.length > this.maxLogSize) {
      this.messageLog = this.messageLog.slice(-this.maxLogSize);
    }

    // Check if this is a reply to a pending request
    if (full.type === 'reply' && full.replyTo) {
      const pending = this.pendingReplies.get(full.replyTo);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingReplies.delete(full.replyTo);
        pending.resolve(full);
      }
    }

    // Route to subscribers
    for (const sub of this.subscriptions) {
      if (sub.topic !== full.topic && sub.topic !== '*') continue;
      if (full.to && sub.agentName && full.to !== sub.agentName) continue;

      try {
        await sub.handler(full);
      } catch (err) {
        console.error(`[bus] Handler error on topic ${full.topic}:`, err);
      }
    }
  }

  // ── Subscribe ────────────────────────────────────────────────────

  subscribe(topic: string, handler: MessageHandler, agentName?: string): () => void {
    const sub: Subscription = { topic, handler, agentName };
    this.subscriptions.push(sub);

    // Return unsubscribe function
    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  // ── Request/Reply (with timeout) ─────────────────────────────────

  async request(
    msg: Omit<BusMessage, 'id' | 'timestamp' | 'type'>,
    timeoutMs = 30_000,
  ): Promise<BusMessage> {
    const id = randomUUID();

    const promise = new Promise<BusMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(id);
        reject(new Error(`Bus request timeout after ${timeoutMs}ms (topic: ${msg.topic}, to: ${msg.to})`));
      }, timeoutMs);

      this.pendingReplies.set(id, { resolve, timeout });
    });

    await this.publish({
      ...msg,
      type: 'request',
    });

    // The actual published message gets a different ID, but we need
    // responders to reference our request. Let's fix this:
    // Re-publish with the known ID so responders can reply to it
    const full: BusMessage = {
      ...msg,
      id,
      type: 'request',
      timestamp: new Date().toISOString(),
    };

    // Replace the auto-generated one
    this.messageLog[this.messageLog.length - 1] = full;

    // Re-route with correct ID
    for (const sub of this.subscriptions) {
      if (sub.topic !== full.topic && sub.topic !== '*') continue;
      if (full.to && sub.agentName && full.to !== sub.agentName) continue;
      try { await sub.handler(full); } catch { /* logged above */ }
    }

    return promise;
  }

  // ── Reply to a request ───────────────────────────────────────────

  async reply(
    originalMsg: BusMessage,
    from: string,
    payload: Record<string, unknown>,
    attachments?: FileAttachment[],
  ): Promise<void> {
    await this.publish({
      topic: originalMsg.topic.replace('.request', '.reply'),
      from,
      to: originalMsg.from,
      type: 'reply',
      payload,
      replyTo: originalMsg.id,
      attachments,
      runId: originalMsg.runId,
    });
  }

  // ── Query log ────────────────────────────────────────────────────

  getRecentMessages(limit = 50, topic?: string): BusMessage[] {
    let msgs = this.messageLog;
    if (topic) msgs = msgs.filter((m) => m.topic === topic);
    return msgs.slice(-limit);
  }

  getSubscriptionCount(): number {
    return this.subscriptions.length;
  }
}

// ── Singleton ────────────────────────────────────────────────────────

let instance: MessageBus | null = null;

export function getBus(): MessageBus {
  if (!instance) instance = new MessageBus();
  return instance;
}
