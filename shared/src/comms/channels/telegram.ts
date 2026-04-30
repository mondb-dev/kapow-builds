/**
 * Telegram Channel
 *
 * OutputChannel adapter that sends pipeline notifications to a
 * Telegram chat via the Bot API. Supports both private chats
 * and group/channel destinations.
 *
 * Setup:
 * 1. Create a bot via @BotFather → get the bot token
 * 2. Get your chat ID (message @userinfobot or use getUpdates)
 * 3. Set COMMS_TELEGRAM_BOT_TOKEN and COMMS_TELEGRAM_CHAT_ID
 *
 * Security:
 * - Bot token is never sent to external services
 * - Messages go directly to Telegram's API over HTTPS
 * - No inbound webhook needed (push-only)
 */
import axios from 'axios';
import type {
  OutputChannel, TaskStatus, TaskOutput, EventSeverity,
} from '../types.js';
import type {
  IOChannel, InboundHandler, InboundMessage, InboundAttachment,
  PromptRequest, PromptHandle,
} from '../inbound.js';

export interface TelegramChannelConfig {
  /** Telegram Bot API token (from @BotFather) */
  botToken: string;
  /** Target chat/group/channel ID */
  chatId: string;
  /** Optional message thread ID (for topic-based groups) */
  threadId?: number;
  /** Parse mode: MarkdownV2 or HTML (default: HTML) */
  parseMode?: 'MarkdownV2' | 'HTML';
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Disable link previews (default: true) */
  disablePreview?: boolean;
}

const STATUS_EMOJI: Record<TaskStatus, string> = {
  BACKLOG: '\u{1F4CB}',     // 📋
  IN_PROGRESS: '\u{1F6E0}', // 🛠
  QA: '\u{1F50D}',          // 🔍
  DONE: '\u{2705}',         // ✅
  FAILED: '\u{274C}',       // ❌
};

const SEVERITY_EMOJI: Record<EventSeverity, string> = {
  INFO: '\u{2139}\u{FE0F}',    // ℹ️
  SUCCESS: '\u{2705}',          // ✅
  ERROR: '\u{1F6A8}',           // 🚨
  PROGRESS: '\u{23F3}',         // ⏳
};

export class TelegramChannel implements IOChannel {
  readonly name = 'telegram';
  readonly supportsTracking = false;
  private botToken: string;
  private chatId: string;
  private threadId?: number;
  private parseMode: 'MarkdownV2' | 'HTML';
  private timeoutMs: number;
  private disablePreview: boolean;

  // Inbound state
  private pollOffset = 0;
  private polling = false;
  private pollAbort?: AbortController;
  private inboundHandler?: InboundHandler;

  constructor(config: TelegramChannelConfig) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.threadId = config.threadId;
    this.parseMode = config.parseMode ?? 'HTML';
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.disablePreview = config.disablePreview ?? true;
  }

  async init(): Promise<void> {
    // Verify bot token works
    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${this.botToken}/getMe`,
        { timeout: this.timeoutMs },
      );
      const botName = res.data?.result?.username ?? 'unknown';
      console.log(`[telegram] Connected as @${botName}, target chat: ${this.chatId}`);
    } catch (err) {
      throw new Error(`Telegram bot token invalid: ${err instanceof Error ? err.message : err}`);
    }
  }

  async onStatusChanged(
    taskId: string,
    _cardId: string,
    status: TaskStatus,
    output?: TaskOutput,
  ): Promise<void> {
    const emoji = STATUS_EMOJI[status];
    let text = `${emoji} <b>${status}</b> — Task <code>${this.esc(taskId)}</code>`;
    if (output?.summary) {
      text += `\n${this.esc(output.summary)}`;
    }
    if (output?.files && output.files.length > 0) {
      const fileList = output.files.slice(0, 5).map((f) => `• <code>${this.esc(f.name)}</code>`).join('\n');
      text += `\n\n<b>Files:</b>\n${fileList}`;
      if (output.files.length > 5) {
        text += `\n<i>...and ${output.files.length - 5} more</i>`;
      }
    }
    await this.send(text);
  }

  async onEvent(
    taskId: string,
    _cardId: string,
    message: string,
    severity: EventSeverity,
  ): Promise<void> {
    // Only send errors and successes to avoid spamming the chat
    if (severity !== 'ERROR' && severity !== 'SUCCESS') return;

    const emoji = SEVERITY_EMOJI[severity];
    const text = `${emoji} <code>${this.esc(taskId)}</code> — ${this.esc(message)}`;
    await this.send(text);
  }

  async sendNotification(text: string): Promise<void> {
    await this.send(text);
  }

  async onPipelineComplete(
    runId: string,
    success: boolean,
    summary: string,
  ): Promise<void> {
    const emoji = success ? '\u{1F389}' : '\u{1F4A5}'; // 🎉 or 💥
    const status = success ? 'COMPLETED' : 'FAILED';
    const text = `${emoji} <b>Pipeline ${status}</b>\nRun: <code>${this.esc(runId)}</code>\n${this.esc(summary)}`;
    await this.send(text);
  }

  // ── Inbound (long-polling) ──────────────────────────────────────

  async startInbound(handler: InboundHandler): Promise<void> {
    if (this.polling) return;
    this.inboundHandler = handler;
    this.polling = true;
    this.pollAbort = new AbortController();
    void this.pollLoop();
    console.log(`[telegram] Inbound long-poll started`);
  }

  async stopInbound(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
  }

  async destroy(): Promise<void> {
    await this.stopInbound();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const res = await axios.get(
          `https://api.telegram.org/bot${this.botToken}/getUpdates`,
          {
            params: {
              offset: this.pollOffset,
              timeout: 25,
              allowed_updates: ['message', 'callback_query'],
            },
            timeout: 30_000,
            signal: this.pollAbort?.signal,
          },
        );
        const updates: TgUpdate[] = res.data?.result ?? [];
        for (const upd of updates) {
          this.pollOffset = upd.update_id + 1;
          const msg = this.parseUpdate(upd);
          if (msg && this.inboundHandler) {
            try {
              await this.inboundHandler(msg);
            } catch (err) {
              console.error(`[telegram] Inbound handler threw:`, err instanceof Error ? err.message : err);
            }
          }
          // ACK callback queries so the spinner stops
          if (upd.callback_query?.id) {
            await this.answerCallback(upd.callback_query.id).catch(() => undefined);
          }
        }
      } catch (err) {
        if (!this.polling) break;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[telegram] Poll error: ${msg}`);
        await sleep(2000);
      }
    }
  }

  private parseUpdate(upd: TgUpdate): InboundMessage | null {
    if (upd.callback_query) {
      const cb = upd.callback_query;
      const m = cb.message;
      if (!m) return null;
      // Only respect callbacks from our configured chat
      if (String(m.chat?.id) !== String(this.chatId)) return null;
      return {
        channel: 'telegram',
        channelName: this.name,
        channelId: String(m.chat.id),
        threadId: m.message_thread_id !== undefined ? String(m.message_thread_id) : 'default',
        messageId: String(m.message_id),
        userId: String(cb.from.id),
        userName: cb.from.username ?? cb.from.first_name ?? `tg-${cb.from.id}`,
        text: '',
        attachments: [],
        callbackData: cb.data,
        receivedAt: new Date(),
      };
    }
    const m = upd.message;
    if (!m) return null;
    if (String(m.chat?.id) !== String(this.chatId)) return null;
    if (this.threadId !== undefined && m.message_thread_id !== this.threadId) return null;

    const attachments: InboundAttachment[] = [];
    if (m.photo && m.photo.length > 0) {
      const largest = m.photo[m.photo.length - 1];
      attachments.push({ kind: 'image', fileId: largest.file_id, sizeBytes: largest.file_size });
    }
    if (m.document) {
      attachments.push({
        kind: 'document', fileId: m.document.file_id,
        name: m.document.file_name, mimeType: m.document.mime_type,
        sizeBytes: m.document.file_size,
      });
    }
    if (m.voice) {
      attachments.push({ kind: 'audio', fileId: m.voice.file_id, mimeType: m.voice.mime_type, sizeBytes: m.voice.file_size });
    }

    return {
      channel: 'telegram',
      channelName: this.name,
      channelId: String(m.chat.id),
      threadId: m.message_thread_id !== undefined ? String(m.message_thread_id) : 'default',
      messageId: String(m.message_id),
      userId: String(m.from?.id ?? 'unknown'),
      userName: m.from?.username ?? m.from?.first_name ?? `tg-${m.from?.id ?? '?'}`,
      text: m.text ?? m.caption ?? '',
      attachments,
      receivedAt: new Date(m.date * 1000),
    };
  }

  // ── Interactive prompt ──────────────────────────────────────────

  async prompt(req: PromptRequest, handleId: string): Promise<PromptHandle> {
    const buttons = req.buttons ?? [];
    const reply_markup = buttons.length > 0
      ? {
          inline_keyboard: [
            buttons.map((b) => ({
              text: b.label,
              // callback_data limited to 64 bytes — keep it short
              callback_data: `${handleId}:${b.id}`.slice(0, 64),
            })),
          ],
        }
      : undefined;

    const messageId = await this.sendRaw(req.text, reply_markup);
    return {
      id: handleId,
      conversationId: req.conversationId,
      kind: req.kind,
      channelName: this.name,
      messageId: messageId !== null ? String(messageId) : undefined,
      createdAt: new Date(),
    };
  }

  private async answerCallback(callbackQueryId: string): Promise<void> {
    await axios.post(
      `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`,
      { callback_query_id: callbackQueryId },
      { timeout: this.timeoutMs },
    );
  }

  // ── Internal ────────────────────────────────────────────────────

  private async send(text: string): Promise<void> {
    await this.sendRaw(text);
  }

  private async sendRaw(text: string, replyMarkup?: unknown): Promise<number | null> {
    try {
      const res = await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: this.chatId,
          text,
          parse_mode: this.parseMode,
          disable_web_page_preview: this.disablePreview,
          ...(this.threadId ? { message_thread_id: this.threadId } : {}),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
        { timeout: this.timeoutMs },
      );
      return res.data?.result?.message_id ?? null;
    } catch (err: unknown) {
      const body = (err as { response?: { data?: unknown } })?.response?.data;
      console.error(`[telegram] Failed to send message:`, err instanceof Error ? err.message : err, body ?? '');
      return null;
    }
  }

  /** Escape HTML special chars for Telegram HTML parse mode */
  private esc(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

// ── Minimal TG update typing ────────────────────────────────────────

interface TgUser { id: number; username?: string; first_name?: string; }
interface TgChat { id: number; }
interface TgPhoto { file_id: string; file_size?: number; }
interface TgDocument { file_id: string; file_name?: string; mime_type?: string; file_size?: number; }
interface TgVoice { file_id: string; mime_type?: string; file_size?: number; }
interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhoto[];
  document?: TgDocument;
  voice?: TgVoice;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
