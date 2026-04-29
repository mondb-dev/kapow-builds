/**
 * Inbound + Interactive Comms
 *
 * Extends OutputChannel with two capabilities:
 *
 *   1. Inbound — channels that can receive user messages (TG, Slack DMs)
 *      register a handler and forward parsed InboundMessage events.
 *
 *   2. Prompt/Reply — pipelines block on a user decision (approve/revise)
 *      via prompt() → returns a handle → awaitReply() resolves when the
 *      user answers. Pairs with the Approval table for audit trail.
 *
 * Channel-agnostic: TG inline-keyboard buttons, Slack block actions, and
 * a board approve button all surface as the same InboundReply shape.
 */
import type { OutputChannel } from './types.js';

// ── Inbound messages ────────────────────────────────────────────────

export type InboundChannelKind = 'telegram' | 'slack' | 'board' | 'webhook';

export interface InboundAttachment {
  kind: 'image' | 'document' | 'audio';
  url?: string;          // remote URL if hosted by the platform
  fileId?: string;       // platform-specific id (e.g. TG file_id)
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface InboundMessage {
  channel: InboundChannelKind;
  channelName: string;            // e.g. 'telegram', 'slack-ops'
  channelId: string;              // platform chat/channel id
  threadId: string;               // thread/topic id; falls back to top-level msg id
  messageId: string;              // platform message id (for replies/edits)
  userId: string;                 // platform user id
  userName: string;               // display name
  text: string;
  attachments: InboundAttachment[];
  /**
   * Set when the message originated from an interactive control
   * (TG inline button, Slack block action). The router uses this
   * to resolve a pending PromptHandle.
   */
  callbackData?: string;
  receivedAt: Date;
}

export type InboundHandler = (msg: InboundMessage) => Promise<void>;

// ── Prompt / Reply ──────────────────────────────────────────────────

export type PromptKind =
  | 'plan_approval'
  | 'design_approval'
  | 'sprint_review'
  | 'pr_approval'
  | 'infra_spend'
  | 'freeform_question';

export interface PromptButton {
  /** Stable id; comes back as InboundReply.choice */
  id: string;
  label: string;
  /** Optional style hint for renderers that support it */
  style?: 'primary' | 'danger' | 'default';
}

export interface PromptRequest {
  /** Conversation key — e.g. the Conversation.id for this thread */
  conversationId: string;
  kind: PromptKind;
  /** Human-readable text shown above the buttons */
  text: string;
  /** Buttons; if omitted, the prompt accepts any free-text reply */
  buttons?: PromptButton[];
  /** Arbitrary structured payload persisted with the Approval row */
  payload?: Record<string, unknown>;
  /** Resolve after this many ms with status='expired' (default: 24h) */
  timeoutMs?: number;
}

export interface PromptHandle {
  /** Unique id; encoded into callback_data so replies can resolve it */
  id: string;
  conversationId: string;
  kind: PromptKind;
  channelName: string;
  /** Platform message id of the prompt itself (so the channel can edit it on reply) */
  messageId?: string;
  createdAt: Date;
}

export interface InboundReply {
  handleId: string;
  status: 'answered' | 'expired' | 'cancelled';
  /** When buttons were used: the chosen button id. Otherwise undefined. */
  choice?: string;
  /** Free-text reply (always populated for text replies; may accompany choice) */
  text?: string;
  userId: string;
  userName: string;
  receivedAt: Date;
}

// ── IOChannel (extends OutputChannel) ───────────────────────────────

/**
 * A channel that can both send and receive. All inbound methods are
 * optional — push-only channels (webhook, board) just don't implement them.
 */
export interface IOChannel extends OutputChannel {
  /** Begin listening for inbound messages; calls handler for each. */
  startInbound?(handler: InboundHandler): Promise<void>;

  /** Stop the inbound loop. */
  stopInbound?(): Promise<void>;

  /**
   * Send an interactive prompt and return a handle the bus can wait on.
   * The channel is responsible for rendering buttons natively
   * (TG inline keyboard, Slack blocks, etc.) and encoding handle.id
   * into the platform's callback mechanism.
   */
  prompt?(req: PromptRequest, handleId: string): Promise<PromptHandle>;
}

// ── Type guards ─────────────────────────────────────────────────────

export function supportsInbound(ch: OutputChannel): ch is IOChannel & { startInbound: NonNullable<IOChannel['startInbound']> } {
  return typeof (ch as IOChannel).startInbound === 'function';
}

export function supportsPrompt(ch: OutputChannel): ch is IOChannel & { prompt: NonNullable<IOChannel['prompt']> } {
  return typeof (ch as IOChannel).prompt === 'function';
}
