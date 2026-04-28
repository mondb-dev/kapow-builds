/**
 * Output Channel Types
 *
 * Standard interface for pipeline outbound communication.
 * Any notification sink (board, Slack, Discord, Telegram, webhook)
 * implements OutputChannel to receive pipeline updates.
 *
 * Security:
 * - Each channel authenticates independently (API keys, HMAC, OAuth)
 * - Channels fail in isolation — one down channel doesn't block others
 * - No secrets or credentials flow through the interface itself
 */

// ── Primitives ──────────────────────────────────────────────────────

export type TaskStatus = 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
export type EventSeverity = 'INFO' | 'SUCCESS' | 'ERROR' | 'PROGRESS';

// ── Payloads ────────────────────────────────────────────────────────

export interface TaskCreatePayload {
  title: string;
  description: string;
  status: TaskStatus;
  runId: string;
  phaseId: string;
  taskId: string;
  projectId?: string;
}

export interface TaskOutput {
  type: 'files' | 'url' | 'summary';
  files?: Array<{ name: string; path: string; size?: number }>;
  url?: string;
  summary?: string;
  runId?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description?: string;
  status: string;
  taskId?: string | null;
  phaseId?: string | null;
}

// ── OutputChannel interface ─────────────────────────────────────────

export interface OutputChannel {
  /** Human-readable channel name (e.g. 'board', 'slack-ops', 'discord-dev') */
  readonly name: string;

  /**
   * Whether this channel supports task tracking (create/list).
   * Only tracker channels are queried for existing task state.
   * Notification-only channels set this to false or omit it.
   */
  readonly supportsTracking: boolean;

  /**
   * If true, an unrecoverable failure on this channel must fail the pipeline
   * rather than be silently isolated. Use for the channel that owns durable
   * audit trail (the board, in default deployments). Optional channels like
   * Slack/Telegram should leave this false.
   */
  readonly critical?: boolean;

  /** Initialize the channel (validate config, establish connections). */
  init?(): Promise<void>;

  /** Tear down resources (close connections, flush buffers). */
  destroy?(): Promise<void>;

  // ── Tracking (optional — only tracker channels) ─────────────────

  /** Create a trackable task item. Returns a record with an assigned ID. */
  createTask?(payload: TaskCreatePayload): Promise<TaskRecord>;

  /** List existing task records for a run (used for pipeline resumption). */
  listTasks?(runId: string): Promise<TaskRecord[]>;

  // ── Notifications (all channels) ────────────────────────────────

  /** Task status changed (optionally with output/artifacts). */
  onStatusChanged(
    taskId: string,
    cardId: string,
    status: TaskStatus,
    output?: TaskOutput,
  ): Promise<void>;

  /** Progress event or log entry for a task. */
  onEvent(
    taskId: string,
    cardId: string,
    message: string,
    severity: EventSeverity,
  ): Promise<void>;

  /** Pipeline run completed (success or failure). */
  onPipelineComplete?(
    runId: string,
    success: boolean,
    summary: string,
  ): Promise<void>;

  /**
   * Send a free-form notification — not tied to a task/card. Used by the
   * comms router to reply to user commands. Channels that don't support
   * direct messaging (webhooks, board) can ignore this.
   */
  sendNotification?(text: string): Promise<void>;
}

// ── Webhook Configuration ───────────────────────────────────────────

export interface WebhookChannelConfig {
  /** Channel name for logging */
  name: string;
  /** Target URL to POST events to */
  url: string;
  /** HMAC secret for request signing (sha256) */
  secret: string;
  /** Additional headers to include (e.g. Authorization) */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Which event types to send (default: all) */
  events?: Array<'task.created' | 'task.status' | 'task.event' | 'pipeline.complete'>;
}
