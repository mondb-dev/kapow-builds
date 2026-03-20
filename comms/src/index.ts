import express, { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { handleMessage, type ReplyFn, type Platform } from './handler.js';
import {
  SlackAdapter, WebhookAdapter,
  type ChannelAdapter, type ChannelMessage, type ChannelReply,
} from './channels/index.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT ?? '3008', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

function isWebhookAuthorized(req: Request): boolean {
  const expected = process.env.COMMS_WEBHOOK_SECRET ?? process.env.INTERNAL_API_KEY ?? process.env.AUTH_SECRET ?? '';
  if (!expected) return false;

  const provided = req.header('x-kapow-webhook-secret') ?? '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

// ── Channel adapter registry ─────────────────────────────────────────

const adapters: ChannelAdapter[] = [];
const webhookAdapter = new WebhookAdapter();
adapters.push(webhookAdapter);

function createMessageHandler(platform: Platform) {
  return async (msg: ChannelMessage): Promise<ChannelReply[]> => {
    const replies: ChannelReply[] = [];
    const reply: ReplyFn = async (text: string) => {
      replies.push({ text, format: platform });
    };
    await handleMessage(
      msg.channelId,
      msg.threadId,
      msg.userId,
      msg.userName,
      msg.text,
      reply,
      platform,
    );
    return replies;
  };
}

// ── Health ────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'kapow-comms',
    channels: adapters.map((a) => ({ platform: a.platform, healthy: a.isHealthy() })),
  });
});

// ── Webhook endpoint (generic, for any platform) ─────────────────────

webhookAdapter.onMessage(createMessageHandler('plain'));

app.post('/webhook', async (req: Request, res: Response) => {
  if (!isWebhookAuthorized(req)) {
    res.status(401).json({ error: 'Webhook authorization required' });
    return;
  }

  const { channelId, threadId, userId, userName, text, platform } = req.body as {
    channelId?: string; threadId?: string; userId?: string;
    userName?: string; text?: string; platform?: Platform;
  };

  if (!channelId || !threadId || !text) {
    res.status(400).json({ error: 'channelId, threadId, and text are required' });
    return;
  }

  const replies = await webhookAdapter.handleIncoming({
    channelId,
    threadId,
    userId: userId ?? 'webhook-user',
    userName: userName ?? 'Webhook User',
    text,
  });

  res.json({ replies });
});

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  // Start Express for health + webhooks
  app.listen(PORT, HOST, () => {
    console.log(`[comms] HTTP server on ${HOST}:${PORT}`);
  });

  await webhookAdapter.start();

  // Start Slack adapter if configured
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET) {
    try {
      const slack = new SlackAdapter();
      slack.onMessage(createMessageHandler('slack'));
      await slack.start();
      adapters.push(slack);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[comms] Slack adapter failed: ${msg}`);
      console.log('[comms] Running in webhook-only mode.');
    }
  } else {
    console.log('[comms] No Slack credentials — webhook-only mode.');
  }

  // Add more adapters here:
  // if (process.env.DISCORD_BOT_TOKEN) {
  //   const discord = new DiscordAdapter();
  //   discord.onMessage(createMessageHandler('discord'));
  //   await discord.start();
  //   adapters.push(discord);
  // }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
