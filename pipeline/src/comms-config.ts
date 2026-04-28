/**
 * Comms Channel Configuration
 *
 * Reads environment variables and registers output channels on
 * the CommsBus. The board channel is always registered by default.
 *
 * Supported channels (set env vars to enable):
 *
 *   Slack:
 *     COMMS_SLACK_BOT_TOKEN      — Bot OAuth token (xoxb-...)
 *     COMMS_SLACK_CHANNEL        — Target channel ID or #name
 *
 *   Telegram:
 *     COMMS_TELEGRAM_BOT_TOKEN   — Bot token from @BotFather
 *     COMMS_TELEGRAM_CHAT_ID     — Target chat/group ID
 *     COMMS_TELEGRAM_THREAD_ID   — (optional) Topic thread ID
 *
 *   Webhook (generic — works for Discord, custom dashboards, etc.):
 *     COMMS_WEBHOOK_URL           — Target URL
 *     COMMS_WEBHOOK_SECRET        — HMAC signing secret
 *     COMMS_WEBHOOK_NAME          — (optional) Channel name, default "webhook"
 *     COMMS_WEBHOOK_EVENTS        — (optional) Comma-separated event filter
 *
 *   Multiple channels via JSON:
 *     COMMS_CHANNELS              — JSON array of channel configs
 *
 * All channels are optional. If none are configured, only the
 * board channel is active (same as before this feature).
 */
import {
  TelegramChannel, WebhookChannel, SlackOutputChannel,
  type WebhookChannelConfig,
} from 'kapow-shared';
import { getCommsBus } from './orchestrator.js';

type WebhookEvent = 'task.created' | 'task.status' | 'task.event' | 'pipeline.complete';

interface ChannelJsonEntry {
  type: 'telegram' | 'webhook' | 'slack';
  name?: string;
  // Slack
  botToken?: string;
  channel?: string;
  // Telegram
  chatId?: string;
  threadId?: number;
  // Webhook
  url?: string;
  secret?: string;
  headers?: Record<string, string>;
  events?: WebhookEvent[];
}

export function registerChannelsFromEnv(): void {
  const comms = getCommsBus();

  // ── Slack (env vars) ────────────────────────────────────────────
  const slackToken = process.env.COMMS_SLACK_BOT_TOKEN;
  const slackChannel = process.env.COMMS_SLACK_CHANNEL;
  if (slackToken && slackChannel) {
    comms.register(new SlackOutputChannel({
      botToken: slackToken,
      channel: slackChannel,
    }));
    console.log(`[comms] Slack channel registered (${slackChannel})`);
  }

  // ── Telegram (env vars) ─────────────────────────────────────────
  const tgToken = process.env.COMMS_TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.COMMS_TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    const threadId = process.env.COMMS_TELEGRAM_THREAD_ID
      ? parseInt(process.env.COMMS_TELEGRAM_THREAD_ID, 10)
      : undefined;
    comms.register(new TelegramChannel({
      botToken: tgToken,
      chatId: tgChat,
      threadId,
    }));
    console.log(`[comms] Telegram channel registered (chat: ${tgChat})`);
  }

  // ── Webhook (env vars) ──────────────────────────────────────────
  const whUrl = process.env.COMMS_WEBHOOK_URL;
  const whSecret = process.env.COMMS_WEBHOOK_SECRET;
  if (whUrl && whSecret) {
    const eventsRaw = process.env.COMMS_WEBHOOK_EVENTS;
    const events = eventsRaw
      ? eventsRaw.split(',').map((e) => e.trim()) as WebhookChannelConfig['events']
      : undefined;
    comms.register(new WebhookChannel({
      name: process.env.COMMS_WEBHOOK_NAME ?? 'webhook',
      url: whUrl,
      secret: whSecret,
      events,
    }));
    console.log(`[comms] Webhook channel registered (${whUrl})`);
  }

  // ── JSON config (advanced — multiple channels) ──────────────────
  const channelsJson = process.env.COMMS_CHANNELS;
  if (channelsJson) {
    try {
      const entries: ChannelJsonEntry[] = JSON.parse(channelsJson);
      for (const entry of entries) {
        if (entry.type === 'slack' && entry.botToken && entry.channel) {
          comms.register(new SlackOutputChannel({
            botToken: entry.botToken,
            channel: entry.channel,
          }));
          console.log(`[comms] Slack channel "${entry.name ?? 'slack'}" registered from COMMS_CHANNELS`);
        } else if (entry.type === 'telegram' && entry.botToken && entry.chatId) {
          comms.register(new TelegramChannel({
            botToken: entry.botToken,
            chatId: entry.chatId,
            threadId: entry.threadId,
          }));
          console.log(`[comms] Telegram channel "${entry.name ?? 'telegram'}" registered from COMMS_CHANNELS`);
        } else if (entry.type === 'webhook' && entry.url && entry.secret) {
          comms.register(new WebhookChannel({
            name: entry.name ?? 'webhook',
            url: entry.url,
            secret: entry.secret,
            headers: entry.headers,
            events: entry.events,
          }));
          console.log(`[comms] Webhook channel "${entry.name ?? 'webhook'}" registered from COMMS_CHANNELS`);
        } else {
          console.warn(`[comms] Skipping invalid channel entry:`, entry.type);
        }
      }
    } catch (err) {
      console.error(`[comms] Invalid COMMS_CHANNELS JSON:`, err instanceof Error ? err.message : err);
    }
  }
}
