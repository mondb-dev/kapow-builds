/**
 * CommsBus — Fan-out Dispatcher
 *
 * Replaces direct BoardClient usage in the pipeline orchestrator.
 * Routes outbound notifications to all registered OutputChannels
 * in parallel, with independent failure isolation.
 *
 * Usage:
 *   const comms = new CommsBus();
 *   comms.register(new BoardChannel());
 *   comms.register(new WebhookChannel({ url: '...', secret: '...' }));
 *   await comms.init();
 *
 *   // Orchestrator calls these instead of board.* directly
 *   const record = await comms.createTask(payload);
 *   await comms.updateStatus(taskId, cardId, 'IN_PROGRESS');
 *   await comms.addEvent(taskId, cardId, 'Builder started', 'PROGRESS');
 */
import type {
  OutputChannel, TaskCreatePayload, TaskRecord,
  TaskStatus, TaskOutput, EventSeverity,
} from './types.js';
import {
  supportsInbound, supportsPrompt,
  type IOChannel, type InboundHandler, type InboundMessage,
  type PromptRequest, type PromptHandle, type InboundReply,
} from './inbound.js';

interface PendingPrompt {
  handle: PromptHandle;
  resolve: (reply: InboundReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CommsBus {
  private channels: OutputChannel[] = [];
  private inboundHandler: InboundHandler | null = null;
  private pending = new Map<string, PendingPrompt>();
  private promptSeq = 0;

  /** Register a channel. Call before init(). */
  register(channel: OutputChannel): void {
    this.channels.push(channel);
  }

  /** Initialize all registered channels. */
  async init(): Promise<void> {
    await Promise.allSettled(
      this.channels.map(async (ch) => {
        try {
          await ch.init?.();
          console.log(`[comms] Channel "${ch.name}" initialized.`);
        } catch (err) {
          console.error(`[comms] Channel "${ch.name}" failed to init:`, err instanceof Error ? err.message : err);
        }
      }),
    );
  }

  /** Tear down all channels. */
  async destroy(): Promise<void> {
    await Promise.allSettled(
      this.channels.map((ch) => ch.destroy?.() ?? Promise.resolve()),
    );
  }

  /** Number of registered channels. */
  get channelCount(): number {
    return this.channels.length;
  }

  // ── Inbound + Interactive ───────────────────────────────────────

  /**
   * Register a single inbound handler invoked for every message arriving
   * on any inbound-capable channel. The bus first tries to resolve pending
   * prompts (by callback_data); anything unresolved is forwarded to the
   * handler for routing.
   */
  async startInbound(handler: InboundHandler): Promise<void> {
    this.inboundHandler = handler;
    await Promise.allSettled(
      this.channels.map(async (ch) => {
        if (!supportsInbound(ch)) return;
        try {
          await ch.startInbound((msg) => this.dispatchInbound(msg));
        } catch (err) {
          console.error(`[comms] startInbound on "${ch.name}" failed:`, err instanceof Error ? err.message : err);
        }
      }),
    );
  }

  private async dispatchInbound(msg: InboundMessage): Promise<void> {
    // Callback data carries `<handleId>:<choice>` — resolve a pending prompt
    if (msg.callbackData) {
      const [handleId, choice] = msg.callbackData.split(':', 2);
      const pending = this.pending.get(handleId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(handleId);
        pending.resolve({
          handleId,
          status: 'answered',
          choice,
          userId: msg.userId,
          userName: msg.userName,
          receivedAt: msg.receivedAt,
        });
        return;
      }
      // Stale button click — no pending prompt (e.g. after a server restart)
      await this.notify('⚠️ This approval prompt has expired (server restarted). Use /resume to restart the run.').catch(() => undefined);
      return;
    }
    // Otherwise route to the registered inbound handler
    if (this.inboundHandler) {
      try {
        await this.inboundHandler(msg);
      } catch (err) {
        console.error(`[comms] inbound handler threw:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Send an interactive prompt and resolve when the user answers.
   * Picks the first prompt-capable channel (typically Telegram). Returns
   * an InboundReply with status='answered'|'expired'.
   */
  async prompt(req: PromptRequest): Promise<InboundReply> {
    const channel = this.channels.find(supportsPrompt);
    if (!channel) {
      throw new Error('No prompt-capable channel registered');
    }
    const handleId = `p${Date.now().toString(36)}${(this.promptSeq++).toString(36)}`;
    const handle = await channel.prompt(req, handleId);
    const timeoutMs = req.timeoutMs ?? 24 * 60 * 60 * 1000;

    return new Promise<InboundReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(handleId);
        resolve({
          handleId,
          status: 'expired',
          userId: '',
          userName: '',
          receivedAt: new Date(),
        });
      }, timeoutMs);
      this.pending.set(handleId, { handle, resolve, timer });
    });
  }

  /** Cancel a pending prompt (e.g. on run cancel). */
  cancelPrompt(handleId: string): void {
    const pending = this.pending.get(handleId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(handleId);
    pending.resolve({
      handleId,
      status: 'cancelled',
      userId: '',
      userName: '',
      receivedAt: new Date(),
    });
  }

  // ── Tracking (delegated to first tracker channel) ───────────────

  /**
   * Create a trackable task. Delegates to the first channel that
   * supports tracking (typically the board). All channels receive
   * the creation as a notification.
   */
  async createTask(payload: TaskCreatePayload): Promise<TaskRecord> {
    let record: TaskRecord = {
      id: `local-${payload.taskId}`,
      title: payload.title,
      status: payload.status,
      taskId: payload.taskId,
      phaseId: payload.phaseId,
    };

    // Create in the first tracker channel
    for (const ch of this.channels) {
      if (ch.supportsTracking && ch.createTask) {
        try {
          record = await ch.createTask(payload);
        } catch (err) {
          console.error(`[comms] Tracker "${ch.name}" createTask failed:`, err instanceof Error ? err.message : err);
        }
        break;
      }
    }

    // Notify all channels about the new task
    await this.broadcast(async (ch) => {
      // Skip the tracker that already created it
      if (ch.supportsTracking && ch.createTask) return;
      await ch.onEvent(
        payload.taskId,
        record.id,
        `Task created: ${payload.title}`,
        'INFO',
      );
    });

    return record;
  }

  /**
   * List existing tasks for a run. Queries the first tracker channel.
   */
  async listTasks(runId: string): Promise<TaskRecord[]> {
    for (const ch of this.channels) {
      if (ch.supportsTracking && ch.listTasks) {
        try {
          return await ch.listTasks(runId);
        } catch (err) {
          console.error(`[comms] Tracker "${ch.name}" listTasks failed:`, err instanceof Error ? err.message : err);
        }
      }
    }
    return [];
  }

  // ── Notifications (broadcast to all channels) ───────────────────

  async updateStatus(
    taskId: string,
    cardId: string,
    status: TaskStatus,
    output?: TaskOutput,
  ): Promise<void> {
    await this.broadcast((ch) => ch.onStatusChanged(taskId, cardId, status, output));
  }

  async addEvent(
    taskId: string,
    cardId: string,
    message: string,
    severity: EventSeverity,
  ): Promise<void> {
    await this.broadcast((ch) => ch.onEvent(taskId, cardId, message, severity));
  }

  /** Send a free-form message to all channels that support it (TG, Slack). */
  async notify(text: string): Promise<void> {
    await this.broadcast((ch) =>
      ch.sendNotification?.(text) ?? Promise.resolve(),
    );
  }

  async pipelineComplete(
    runId: string,
    success: boolean,
    summary: string,
  ): Promise<void> {
    await this.broadcast((ch) =>
      ch.onPipelineComplete?.(runId, success, summary) ?? Promise.resolve(),
    );
  }

  // ── Internal ────────────────────────────────────────────────────

  private async broadcast(
    fn: (ch: OutputChannel) => Promise<void>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      this.channels.map(async (ch) => {
        try {
          await fn(ch);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[comms] Channel "${ch.name}" error:`, msg);
          if (ch.critical) {
            throw new Error(`Critical channel "${ch.name}" failed: ${msg}`);
          }
        }
      }),
    );
    // Surface the first critical-channel rejection so the caller can fail loudly.
    const fatal = results.find((r) => r.status === 'rejected');
    if (fatal && fatal.status === 'rejected') {
      throw fatal.reason instanceof Error ? fatal.reason : new Error(String(fatal.reason));
    }
  }
}
