import type { ChannelAdapter, ChannelMessage, ChannelReply } from './adapter.js';

/**
 * Webhook Adapter
 *
 * Generic HTTP adapter for any platform that can POST messages
 * and receive replies. Used as the fallback when no specific
 * platform adapter is configured.
 *
 * Platforms (Discord bots, Teams connectors, custom UIs) POST to
 * /webhook and get replies synchronously in the response body.
 */
export class WebhookAdapter implements ChannelAdapter {
  readonly platform = 'webhook';
  private handler: ((msg: ChannelMessage) => Promise<ChannelReply[]>) | null = null;

  onMessage(handler: (msg: ChannelMessage) => Promise<ChannelReply[]>): void {
    this.handler = handler;
  }

  /** Called by the Express route handler in index.ts */
  async handleIncoming(msg: ChannelMessage): Promise<ChannelReply[]> {
    if (!this.handler) return [{ text: 'No handler registered' }];
    return this.handler(msg);
  }

  async reply(_channelId: string, _threadId: string, _reply: ChannelReply): Promise<void> {
    // Webhook replies are returned synchronously in the HTTP response.
    // This method is a no-op for the webhook adapter.
  }

  async start(): Promise<void> {
    console.log(`[comms] Webhook adapter ready`);
  }

  async stop(): Promise<void> {
    // Nothing to close
  }

  isHealthy(): boolean {
    return true;
  }
}
