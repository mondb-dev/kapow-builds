/**
 * Bus Client
 *
 * Lightweight HTTP client for agents to connect to the message bus.
 * Agents that run in separate processes use this to publish/subscribe
 * via the bus HTTP API hosted by the actions service.
 */
import axios from 'axios';
import { randomUUID } from 'crypto';
import type { BusMessage, FileAttachment, MessageHandler } from './types.js';
import { getInternalAuthHeaders } from '../internal-auth.js';

export class BusClient {
  private busUrl: string;
  private agentName: string;
  private handlers = new Map<string, MessageHandler[]>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastSeenId: string | null = null;

  constructor(agentName: string, busUrl?: string) {
    this.agentName = agentName;
    this.busUrl = busUrl ?? process.env.BUS_URL ?? 'http://localhost:3000/bus';
  }

  // ── Publish ────────────────────────────────────────────────────────

  async publish(
    topic: string,
    payload: Record<string, unknown>,
    options?: {
      to?: string;
      runId?: string;
      attachments?: FileAttachment[];
    },
  ): Promise<void> {
    await axios.post(`${this.busUrl}/publish`, {
      topic,
      from: this.agentName,
      to: options?.to,
      type: 'event',
      payload,
      runId: options?.runId,
      attachments: options?.attachments,
    }, {
      timeout: 5_000,
      headers: getInternalAuthHeaders(),
    }).catch(() => {
      // Non-blocking — bus might not be available
    });
  }

  // ── Request/Reply ──────────────────────────────────────────────────

  async request(
    topic: string,
    payload: Record<string, unknown>,
    to: string,
    timeoutMs = 30_000,
    runId?: string,
  ): Promise<BusMessage> {
    const res = await axios.post<BusMessage>(`${this.busUrl}/request`, {
      topic,
      from: this.agentName,
      to,
      payload,
      runId,
    }, {
      timeout: timeoutMs + 5_000,
      headers: getInternalAuthHeaders(),
    }); // HTTP timeout slightly longer than bus timeout

    return res.data;
  }

  // ── Subscribe (poll-based for simplicity) ──────────────────────────

  on(topic: string, handler: MessageHandler): void {
    const existing = this.handlers.get(topic) ?? [];
    existing.push(handler);
    this.handlers.set(topic, existing);
  }

  startPolling(intervalMs = 2_000): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      try {
        const res = await axios.get<BusMessage[]>(`${this.busUrl}/messages`, {
          params: { agent: this.agentName, after: this.lastSeenId },
          timeout: 3_000,
          headers: getInternalAuthHeaders(),
        });

        for (const msg of res.data) {
          this.lastSeenId = msg.id;

          // Route to handlers
          const topicHandlers = this.handlers.get(msg.topic) ?? [];
          const wildcardHandlers = this.handlers.get('*') ?? [];

          for (const handler of [...topicHandlers, ...wildcardHandlers]) {
            try {
              await handler(msg);
            } catch (err) {
              console.error(`[bus-client] Handler error:`, err);
            }
          }
        }
      } catch {
        // Bus unavailable — skip
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // ── File helper ────────────────────────────────────────────────────

  static createAttachment(
    name: string,
    content: Buffer | string,
    mimeType: string,
  ): FileAttachment {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    return {
      id: randomUUID(),
      name,
      mimeType,
      size: buf.length,
      content: buf.toString('base64'),
    };
  }
}
