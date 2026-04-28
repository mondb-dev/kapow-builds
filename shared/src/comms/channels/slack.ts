/**
 * Slack Output Channel
 *
 * Sends pipeline notifications to a Slack channel using the
 * Slack Web API (chat.postMessage). Uses the same bot token
 * as the inbound Slack adapter in comms/.
 *
 * Setup:
 * 1. Create a Slack app at https://api.slack.com/apps
 * 2. Add bot scopes: chat:write, chat:write.public
 * 3. Install to workspace → copy the Bot User OAuth Token
 * 4. Set COMMS_SLACK_BOT_TOKEN and COMMS_SLACK_CHANNEL
 *
 * Security:
 * - Uses Bot OAuth token (xoxb-) — scoped to specific permissions
 * - Messages go directly to Slack's API over HTTPS
 * - No inbound webhook needed (push-only)
 */
import axios from 'axios';
import type {
  OutputChannel, TaskStatus, TaskOutput, EventSeverity,
} from '../types.js';

export interface SlackOutputChannelConfig {
  /** Slack Bot OAuth Token (xoxb-...) */
  botToken: string;
  /** Target channel ID or name (e.g. #kapow-builds or C01ABCDEF) */
  channel: string;
  /** Post in a thread under this timestamp (optional) */
  threadTs?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
}

const STATUS_EMOJI: Record<TaskStatus, string> = {
  BACKLOG: ':clipboard:',
  IN_PROGRESS: ':hammer_and_wrench:',
  QA: ':mag:',
  DONE: ':white_check_mark:',
  FAILED: ':x:',
};

const SEVERITY_EMOJI: Record<EventSeverity, string> = {
  INFO: ':information_source:',
  SUCCESS: ':white_check_mark:',
  ERROR: ':rotating_light:',
  PROGRESS: ':hourglass_flowing_sand:',
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  BACKLOG: '#808080',
  IN_PROGRESS: '#2196F3',
  QA: '#FF9800',
  DONE: '#4CAF50',
  FAILED: '#F44336',
};

export class SlackOutputChannel implements OutputChannel {
  readonly name = 'slack';
  readonly supportsTracking = false;
  private botToken: string;
  private channel: string;
  private threadTs?: string;
  private timeoutMs: number;

  constructor(config: SlackOutputChannelConfig) {
    this.botToken = config.botToken;
    this.channel = config.channel;
    this.threadTs = config.threadTs;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async init(): Promise<void> {
    try {
      const res = await axios.post('https://slack.com/api/auth.test', null, {
        headers: { Authorization: `Bearer ${this.botToken}` },
        timeout: this.timeoutMs,
      });
      if (!res.data?.ok) {
        throw new Error(res.data?.error ?? 'auth.test failed');
      }
      console.log(`[slack] Connected as @${res.data.user}, team: ${res.data.team}, channel: ${this.channel}`);
    } catch (err) {
      throw new Error(`Slack bot token invalid: ${err instanceof Error ? err.message : err}`);
    }
  }

  async onStatusChanged(
    taskId: string,
    _cardId: string,
    status: TaskStatus,
    output?: TaskOutput,
  ): Promise<void> {
    const emoji = STATUS_EMOJI[status];
    const color = STATUS_COLOR[status];

    const fields: Array<{ title: string; value: string; short: boolean }> = [
      { title: 'Task', value: `\`${taskId}\``, short: true },
      { title: 'Status', value: `${emoji} *${status}*`, short: true },
    ];

    if (output?.summary) {
      fields.push({ title: 'Summary', value: output.summary, short: false });
    }

    if (output?.files && output.files.length > 0) {
      const fileList = output.files.slice(0, 5).map((f) => `\`${f.name}\``).join(', ');
      const suffix = output.files.length > 5 ? ` _+${output.files.length - 5} more_` : '';
      fields.push({ title: 'Files', value: fileList + suffix, short: false });
    }

    await this.sendAttachment({
      color,
      fallback: `${emoji} ${status} — ${taskId}`,
      fields,
    });
  }

  async onEvent(
    taskId: string,
    _cardId: string,
    message: string,
    severity: EventSeverity,
  ): Promise<void> {
    // Only send errors and successes to keep noise down
    if (severity !== 'ERROR' && severity !== 'SUCCESS') return;

    const emoji = SEVERITY_EMOJI[severity];
    const color = severity === 'ERROR' ? '#F44336' : '#4CAF50';

    await this.sendAttachment({
      color,
      fallback: `${emoji} ${taskId} — ${message}`,
      text: `${emoji} \`${taskId}\` — ${message}`,
    });
  }

  async onPipelineComplete(
    runId: string,
    success: boolean,
    summary: string,
  ): Promise<void> {
    const emoji = success ? ':tada:' : ':boom:';
    const color = success ? '#4CAF50' : '#F44336';
    const status = success ? 'COMPLETED' : 'FAILED';

    await this.sendAttachment({
      color,
      fallback: `${emoji} Pipeline ${status}`,
      fields: [
        { title: `${emoji} Pipeline ${status}`, value: summary, short: false },
        { title: 'Run', value: `\`${runId}\``, short: true },
      ],
    });
  }

  // ── Internal ────────────────────────────────────────────────────

  private async sendAttachment(attachment: Record<string, unknown>): Promise<void> {
    try {
      const res = await axios.post('https://slack.com/api/chat.postMessage', {
        channel: this.channel,
        attachments: [attachment],
        ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
      }, {
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        timeout: this.timeoutMs,
      });
      if (!res.data?.ok) {
        console.error(`[slack] API error: ${res.data?.error}`);
      }
    } catch (err) {
      console.error(`[slack] Failed to send message:`, err instanceof Error ? err.message : err);
    }
  }
}
