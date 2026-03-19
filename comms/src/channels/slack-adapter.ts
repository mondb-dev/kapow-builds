import { App } from '@slack/bolt';
import axios from 'axios';
import type { ChannelAdapter, ChannelMessage, ChannelReply, ChannelFile } from './adapter.js';

export class SlackAdapter implements ChannelAdapter {
  readonly platform = 'slack';
  private app: App;
  private handler: ((msg: ChannelMessage) => Promise<ChannelReply[]>) | null = null;
  private healthy = false;

  constructor() {
    const token = process.env.SLACK_BOT_TOKEN;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const appToken = process.env.SLACK_APP_TOKEN;

    if (!token || !signingSecret) {
      throw new Error('SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are required');
    }

    this.app = new App({
      token,
      signingSecret,
      ...(appToken ? { socketMode: true, appToken } : {}),
    });
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<ChannelReply[]>): void {
    this.handler = handler;

    // Listen for @kapow mentions
    this.app.event('app_mention', async ({ event, say }) => {
      if (!this.handler) return;

      const userName = await this.resolveUserName(event.user);
      const threadTs = event.thread_ts ?? event.ts;
      const files = await this.extractFiles(event as { files?: Array<{ name: string; mimetype: string; size: number; url_private: string }> });

      const replies = await this.handler({
        channelId: event.channel,
        threadId: threadTs,
        userId: event.user,
        userName,
        text: this.stripMention(event.text),
        files: files.length > 0 ? files : undefined,
        raw: event,
      });

      for (const r of replies) {
        await say({ text: r.text, thread_ts: threadTs });
      }
    });

    // Listen for thread replies
    this.app.event('message', async ({ event, say }) => {
      if (!this.handler) return;
      const msg = event as { thread_ts?: string; ts: string; text?: string; user?: string; channel: string; subtype?: string };
      if (!msg.thread_ts || msg.subtype || !msg.text || !msg.user) return;

      const userName = await this.resolveUserName(msg.user);

      const replies = await this.handler({
        channelId: msg.channel,
        threadId: msg.thread_ts,
        userId: msg.user,
        userName,
        text: msg.text,
        raw: msg,
      });

      for (const r of replies) {
        await say({ text: r.text, thread_ts: msg.thread_ts });
      }
    });

    // Slash command
    this.app.command('/kapow', async ({ command, ack, respond }) => {
      await ack();
      if (!command.text || command.text.trim() === '' || command.text.trim() === 'help') {
        await respond({
          text: '*Kapow* — AI Development Pipeline\n\nMention @kapow in any channel with a project description to get started.',
        });
        return;
      }
      await respond({ text: `To start a project, mention @kapow in a channel:\n> @kapow ${command.text}` });
    });
  }

  async reply(channelId: string, threadId: string, reply: ChannelReply): Promise<void> {
    await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text: reply.text,
    });
  }

  async start(): Promise<void> {
    if (process.env.SLACK_APP_TOKEN) {
      await this.app.start();
      console.log(`[comms] Slack adapter started (socket mode)`);
    } else {
      const port = parseInt(process.env.SLACK_PORT ?? '3009', 10);
      await this.app.start(port);
      console.log(`[comms] Slack adapter started on port ${port}`);
    }
    this.healthy = true;
  }

  async stop(): Promise<void> {
    await this.app.stop();
    this.healthy = false;
  }

  async uploadFile(channelId: string, threadId: string, file: ChannelFile): Promise<string | null> {
    try {
      const result = await this.app.client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadId,
        filename: file.name,
        content: file.content,
      });
      return (result as { file?: { permalink?: string } }).file?.permalink ?? null;
    } catch {
      return null;
    }
  }

  async downloadFile(url: string): Promise<Buffer | null> {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        timeout: 30_000,
      });
      return Buffer.from(res.data);
    } catch {
      return null;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private async extractFiles(event: { files?: Array<{ name: string; mimetype: string; size: number; url_private: string }> }): Promise<ChannelFile[]> {
    if (!event.files || event.files.length === 0) return [];

    const files: ChannelFile[] = [];
    for (const f of event.files) {
      const content = await this.downloadFile(f.url_private);
      files.push({
        name: f.name,
        mimeType: f.mimetype,
        size: f.size,
        url: f.url_private,
        content: content ?? undefined,
      });
    }
    return files;
  }

  private stripMention(text: string): string {
    return text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  }

  private async resolveUserName(userId: string): Promise<string> {
    try {
      const info = await this.app.client.users.info({ user: userId });
      return info.user?.real_name ?? info.user?.name ?? 'User';
    } catch {
      return 'User';
    }
  }
}
