# Output Channels

Pipeline notifications (task status, events, build output, pipeline results) are sent to all configured output channels. The kanban board is always active as the default channel. Additional channels can be added via environment variables — no code changes needed.

## Supported Channels

| Channel   | Type              | Auth                  | Use case                          |
|-----------|-------------------|-----------------------|-----------------------------------|
| Board     | Built-in (always) | Internal API key      | Kanban UI, task tracking          |
| Slack     | Push (Web API)    | Bot OAuth token       | Team channels, threaded updates   |
| Telegram  | Push (Bot API)    | Bot token             | Mobile alerts, group notifications|
| Webhook   | Push (HTTP POST)  | HMAC-SHA256 signature | Discord, n8n, Zapier, custom dashboards |

## Slack

Send pipeline updates to a Slack channel with color-coded attachments.

### Setup

1. Create a Slack app at https://api.slack.com/apps (or reuse your existing Kapow app)
2. Go to **OAuth & Permissions** → add bot scopes: `chat:write`, `chat:write.public`
3. Install to workspace → copy the **Bot User OAuth Token** (`xoxb-...`)
4. Add to your `.env`:

```bash
COMMS_SLACK_BOT_TOKEN=xoxb-your-token-here
COMMS_SLACK_CHANNEL=#kapow-builds
```

The channel can be a `#name` or a channel ID (`C01ABCDEF`). If using a private channel, invite the bot first.

### What gets sent

- **Status changes** — color-coded attachments (blue=building, orange=QA, green=done, red=failed)
- **Errors and successes** — build failures, gate escalations, task completions
- **Pipeline completion** — summary with run ID
- Progress and info events are filtered to keep the channel clean

### Note on the existing Slack adapter

The `comms/` service has a separate `SlackAdapter` for **inbound** messages (users mentioning @kapow to start builds). This output channel is **outbound only** — it pushes notifications to Slack. Both can use the same bot token but serve different directions.

## Telegram

Send pipeline updates to a Telegram chat, group, or channel.

### Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the bot token
2. Add the bot to your target group/channel
3. Get the chat ID:
   - For personal chats: message [@userinfobot](https://t.me/userinfobot)
   - For groups: add the bot, send a message, then check `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Group IDs are negative numbers (e.g. `-1001234567890`)
4. Add to your `.env`:

```bash
COMMS_TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
COMMS_TELEGRAM_CHAT_ID=-1001234567890
```

For topic-based (forum) groups, also set the thread ID:

```bash
COMMS_TELEGRAM_THREAD_ID=42
```

### What gets sent

- **Status changes** — task started, QA, done, failed (with emoji indicators)
- **Errors and successes** — build failures, gate escalations, task completions
- **Pipeline completion** — final success/failure summary
- Progress and info events are filtered out to avoid chat spam

## Webhook (Generic)

HMAC-signed HTTP POST to any URL. Works with Discord webhooks, Slack incoming webhooks, n8n, Zapier, or custom services.

### Setup

```bash
COMMS_WEBHOOK_URL=https://your-service.com/webhook
COMMS_WEBHOOK_SECRET=your-hmac-secret
```

Optional:

```bash
COMMS_WEBHOOK_NAME=discord-ops                          # Name for logging (default: "webhook")
COMMS_WEBHOOK_EVENTS=task.status,pipeline.complete      # Only send these events
```

### Payload format

Every POST body is JSON:

```json
{
  "event": "task.status",
  "timestamp": "2026-04-08T12:00:00.000Z",
  "payload": {
    "taskId": "task_1",
    "cardId": "card-uuid",
    "status": "DONE",
    "output": { "type": "files", "files": [...] }
  }
}
```

### Event types

| Event              | When                              | Payload fields                          |
|--------------------|-----------------------------------|-----------------------------------------|
| `task.created`     | New task registered               | `taskId`, `cardId`, message             |
| `task.status`      | Status change                     | `taskId`, `cardId`, `status`, `output?` |
| `task.event`       | Progress log entry                | `taskId`, `cardId`, `message`, `severity` |
| `pipeline.complete`| Pipeline finished                 | `runId`, `success`, `summary`           |

### Security headers

| Header               | Value                               |
|----------------------|-------------------------------------|
| `Content-Type`       | `application/json`                  |
| `X-Kapow-Event`     | Event type (e.g. `task.status`)     |
| `X-Kapow-Signature` | `sha256=<HMAC-SHA256 hex digest>`   |
| `X-Kapow-Timestamp` | ISO-8601 timestamp                  |

### Verifying signatures

Receivers should verify the HMAC to ensure the request is authentic:

```javascript
import { createHmac, timingSafeEqual } from 'crypto';

function verify(secret, body, signatureHeader) {
  const expected = createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  const received = signatureHeader.replace('sha256=', '');
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex'),
  );
}
```

## Multiple Channels (JSON Config)

To configure multiple channels at once, use the `COMMS_CHANNELS` env var with a JSON array:

```bash
COMMS_CHANNELS='[
  {
    "type": "telegram",
    "botToken": "123456:ABC...",
    "chatId": "-1001234567890"
  },
  {
    "type": "webhook",
    "name": "discord-dev",
    "url": "https://discord.com/api/webhooks/...",
    "secret": "discord-hmac-secret",
    "events": ["task.status", "pipeline.complete"]
  },
  {
    "type": "webhook",
    "name": "slack-ops",
    "url": "https://hooks.slack.com/services/...",
    "secret": "slack-hmac-secret"
  }
]'
```

Channels from `COMMS_CHANNELS` are added alongside any channels configured via individual env vars (`COMMS_TELEGRAM_*`, `COMMS_WEBHOOK_*`).

## Implementing a Custom Channel

Any class implementing the `OutputChannel` interface works. Register it before the pipeline starts:

```typescript
import { getCommsBus } from './orchestrator.js';
import type { OutputChannel, TaskStatus, TaskOutput, EventSeverity } from 'kapow-shared';

class DiscordBotChannel implements OutputChannel {
  readonly name = 'discord-bot';
  readonly supportsTracking = false;

  async onStatusChanged(taskId: string, cardId: string, status: TaskStatus, output?: TaskOutput) {
    // Send to Discord via bot API
  }

  async onEvent(taskId: string, cardId: string, message: string, severity: EventSeverity) {
    // Send to Discord via bot API
  }

  async onPipelineComplete(runId: string, success: boolean, summary: string) {
    // Send to Discord via bot API
  }
}

// Register before pipeline runs
getCommsBus().register(new DiscordBotChannel());
```

### OutputChannel interface

| Method              | Required | Purpose                                     |
|---------------------|----------|---------------------------------------------|
| `name`              | Yes      | Channel identifier for logging              |
| `supportsTracking`  | Yes      | Set `true` if channel manages task records  |
| `init()`            | No       | Validate config, establish connections      |
| `destroy()`         | No       | Clean up resources                          |
| `createTask()`      | No       | Create a trackable task (tracker channels only) |
| `listTasks()`       | No       | List existing tasks (tracker channels only) |
| `onStatusChanged()` | Yes      | Task status changed                         |
| `onEvent()`         | Yes      | Progress event / log entry                  |
| `onPipelineComplete()` | No    | Pipeline run finished                       |

### Design principles

- **Channels fail independently** — a Telegram outage won't block the pipeline or other channels
- **Fire-and-forget** — notification errors are logged but never thrown
- **Board is always active** — it's the task tracker (creates/lists tasks); other channels are notification sinks
- **No secrets in payloads** — only task metadata flows through the interface
