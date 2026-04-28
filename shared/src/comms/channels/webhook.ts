/**
 * Webhook Channel
 *
 * Generic outbound OutputChannel that POSTs signed JSON payloads
 * to any HTTP endpoint. Covers Discord webhooks, Telegram bots,
 * custom dashboards, or any service that accepts webhooks.
 *
 * Security:
 * - Every request is signed with HMAC-SHA256 using a shared secret
 * - Signature is sent in the X-Kapow-Signature header
 * - Receivers verify: HMAC(secret, rawBody) === signature
 * - Timestamps included to prevent replay attacks
 *
 * Standard webhook format (receivers parse this):
 * {
 *   event: 'task.status' | 'task.event' | 'task.created' | 'pipeline.complete',
 *   timestamp: ISO-8601,
 *   payload: { ... event-specific data ... }
 * }
 */
import axios from 'axios';
import { createHmac } from 'crypto';
import type {
  OutputChannel, TaskStatus, TaskOutput, EventSeverity,
  WebhookChannelConfig,
} from '../types.js';

type WebhookEvent = 'task.created' | 'task.status' | 'task.event' | 'pipeline.complete';

export class WebhookChannel implements OutputChannel {
  readonly name: string;
  readonly supportsTracking = false;
  private url: string;
  private secret: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private allowedEvents: Set<WebhookEvent> | null;

  constructor(config: WebhookChannelConfig) {
    this.name = config.name;
    this.url = config.url;
    this.secret = config.secret;
    this.headers = config.headers ?? {};
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.allowedEvents = config.events ? new Set(config.events) : null;
  }

  // ── Notifications ─────────────────────────────────────────────────

  async onStatusChanged(
    taskId: string,
    cardId: string,
    status: TaskStatus,
    output?: TaskOutput,
  ): Promise<void> {
    await this.send('task.status', { taskId, cardId, status, output });
  }

  async onEvent(
    taskId: string,
    cardId: string,
    message: string,
    severity: EventSeverity,
  ): Promise<void> {
    await this.send('task.event', { taskId, cardId, message, severity });
  }

  async onPipelineComplete(
    runId: string,
    success: boolean,
    summary: string,
  ): Promise<void> {
    await this.send('pipeline.complete', { runId, success, summary });
  }

  // ── Signed POST ───────────────────────────────────────────────────

  private async send(event: WebhookEvent, payload: Record<string, unknown>): Promise<void> {
    if (this.allowedEvents && !this.allowedEvents.has(event)) return;

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      payload,
    });

    const signature = createHmac('sha256', this.secret)
      .update(body)
      .digest('hex');

    try {
      await axios.post(this.url, body, {
        timeout: this.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'X-Kapow-Event': event,
          'X-Kapow-Signature': `sha256=${signature}`,
          'X-Kapow-Timestamp': new Date().toISOString(),
          ...this.headers,
        },
      });
    } catch (err) {
      console.error(
        `[webhook:${this.name}] Failed to send ${event}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
