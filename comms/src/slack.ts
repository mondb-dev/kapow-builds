import { App, type SayFn } from '@slack/bolt';
import { handleMessage, type ReplyFn } from './handler.js';

let app: App | null = null;

export function createSlackBot(): App {
  const token = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!token || !signingSecret) {
    throw new Error('SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are required');
  }

  app = new App({
    token,
    signingSecret,
    // Socket mode for development (no public URL needed)
    ...(appToken ? { socketMode: true, appToken } : {}),
  });

  // ── Listen for @kapow mentions ─────────────────────────────────

  app.event('app_mention', async ({ event, say }) => {
    const text = stripMention(event.text);
    const threadTs = event.thread_ts ?? event.ts; // Keep conversation in a thread
    const userId = event.user;

    // Get user info
    let userName = 'User';
    try {
      const userInfo = await app!.client.users.info({ user: userId });
      userName = userInfo.user?.real_name ?? userInfo.user?.name ?? 'User';
    } catch {
      // Fall back to user ID
    }

    const reply: ReplyFn = async (msg: string) => {
      await say({ text: msg, thread_ts: threadTs });
    };

    await handleMessage(
      event.channel,
      threadTs,
      userId,
      userName,
      text,
      reply,
    );
  });

  // ── Listen for replies in threads where we have a conversation ──

  app.event('message', async ({ event, say }) => {
    // Only handle thread replies (not channel-level messages)
    const msg = event as { thread_ts?: string; ts: string; text?: string; user?: string; channel: string; subtype?: string };

    if (!msg.thread_ts || msg.subtype) return; // Skip non-threaded or system messages
    if (!msg.text || !msg.user) return;

    // Check if this is a thread we're tracking (we'll try to handle it)
    const threadTs = msg.thread_ts;

    let userName = 'User';
    try {
      const userInfo = await app!.client.users.info({ user: msg.user });
      userName = userInfo.user?.real_name ?? userInfo.user?.name ?? 'User';
    } catch {
      // Fall back
    }

    const reply: ReplyFn = async (text: string) => {
      await say({ text, thread_ts: threadTs });
    };

    await handleMessage(
      msg.channel,
      threadTs,
      msg.user,
      userName,
      msg.text,
      reply,
    );
  });

  // ── Slash command: /kapow ──────────────────────────────────────

  app.command('/kapow', async ({ command, ack, respond }) => {
    await ack();

    if (!command.text || command.text.trim() === '' || command.text.trim() === 'help') {
      await respond({
        text: '*Kapow* — AI Development Pipeline\n\nMention @kapow in any channel with a project description to get started.\n\nExample: `@kapow Create a landing page with auth and a dashboard`',
      });
      return;
    }

    await respond({
      text: `To start a project, mention @kapow in a channel:\n> @kapow ${command.text}`,
    });
  });

  return app;
}

function stripMention(text: string): string {
  // Remove <@BOTID> mention prefix
  return text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
}

export async function startSlackBot(): Promise<void> {
  if (!app) throw new Error('Slack bot not created');

  const port = parseInt(process.env.SLACK_PORT ?? '3008', 10);

  if (process.env.SLACK_APP_TOKEN) {
    // Socket mode — no HTTP server needed for Slack
    await app.start();
    console.log(`kapow-comms Slack bot started (socket mode)`);
  } else {
    // HTTP mode — Slack sends events to this URL
    await app.start(port);
    console.log(`kapow-comms Slack bot started on port ${port}`);
  }
}
