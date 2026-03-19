/**
 * Message Bus Types
 *
 * The bus supports three communication patterns:
 * 1. Broadcast — one agent sends to all listeners on a topic
 * 2. Request/Reply — one agent asks another agent and waits for a response
 * 3. File Transfer — attach files/images to any message
 */

// ── Message Envelope ─────────────────────────────────────────────────

export interface BusMessage {
  id: string;
  topic: string;
  from: string;               // agent name (e.g. 'builder', 'qa')
  to?: string;                // target agent for directed messages (undefined = broadcast)
  type: 'event' | 'request' | 'reply' | 'file';
  payload: Record<string, unknown>;
  replyTo?: string;           // message ID this is replying to
  attachments?: FileAttachment[];
  timestamp: string;
  runId?: string;             // pipeline run context
}

// ── File Attachments ─────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Base64-encoded content for small files, or a path/URL for large ones */
  content?: string;
  url?: string;
  path?: string;
}

// ── Topics (well-known channels agents can publish/subscribe to) ─────

export const BusTopics = {
  // Pipeline lifecycle
  PIPELINE_START: 'pipeline.start',
  PIPELINE_PROGRESS: 'pipeline.progress',
  PIPELINE_COMPLETE: 'pipeline.complete',

  // Inter-agent
  CLARIFICATION_REQUEST: 'agent.clarification.request',
  CLARIFICATION_REPLY: 'agent.clarification.reply',
  TOOL_REQUEST: 'agent.tool.request',
  TOOL_READY: 'agent.tool.ready',
  SECURITY_ALERT: 'agent.security.alert',
  SECURITY_STOP: 'agent.security.stop',

  // Build lifecycle
  BUILD_START: 'build.start',
  BUILD_PROGRESS: 'build.progress',
  BUILD_COMPLETE: 'build.complete',
  BUILD_ERROR: 'build.error',

  // QA lifecycle
  QA_START: 'qa.start',
  QA_FINDING: 'qa.finding',
  QA_COMPLETE: 'qa.complete',

  // File sharing
  FILE_SHARED: 'file.shared',
} as const;

export type BusTopic = typeof BusTopics[keyof typeof BusTopics];

// ── Subscription ─────────────────────────────────────────────────────

export type MessageHandler = (msg: BusMessage) => void | Promise<void>;

export interface Subscription {
  topic: string;
  handler: MessageHandler;
  agentName?: string;         // filter to only messages addressed to this agent
}
