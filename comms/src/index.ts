import express, { Request, Response } from 'express';
import { createSlackBot, startSlackBot } from './slack.js';
import { handleMessage, type ReplyFn } from './handler.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT ?? '3008', 10);

// ── Health ───────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-comms' });
});

// ── Generic webhook endpoint (for non-Slack integrations) ────────────
// Other platforms (Discord, Teams, etc.) can POST here

app.post('/webhook', async (req: Request, res: Response) => {
  const { channelId, threadId, userId, userName, text } = req.body as {
    channelId?: string;
    threadId?: string;
    userId?: string;
    userName?: string;
    text?: string;
  };

  if (!channelId || !threadId || !text) {
    res.status(400).json({ error: 'channelId, threadId, and text are required' });
    return;
  }

  const replies: string[] = [];
  const reply: ReplyFn = async (msg: string) => {
    replies.push(msg);
  };

  await handleMessage(
    channelId,
    threadId,
    userId ?? 'webhook-user',
    userName ?? 'Webhook User',
    text,
    reply,
  );

  res.json({ replies });
});

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  // Start Express for health checks and webhooks
  app.listen(PORT, () => {
    console.log(`kapow-comms HTTP server on port ${PORT}`);
  });

  // Start Slack bot if credentials are configured
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET) {
    try {
      createSlackBot();
      await startSlackBot();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Slack bot failed to start: ${msg}`);
      console.log('Comms service running in webhook-only mode.');
    }
  } else {
    console.log('No SLACK_BOT_TOKEN configured — running in webhook-only mode.');
    console.log('Set SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, and optionally SLACK_APP_TOKEN to enable Slack.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
