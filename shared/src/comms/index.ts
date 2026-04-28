// Core
export { CommsBus } from './comms-bus.js';
export type {
  OutputChannel, TaskCreatePayload, TaskRecord,
  TaskStatus, TaskOutput, EventSeverity,
  WebhookChannelConfig,
} from './types.js';
export type {
  IOChannel, InboundHandler, InboundMessage, InboundAttachment,
  InboundChannelKind, PromptKind, PromptButton, PromptRequest,
  PromptHandle, InboundReply,
} from './inbound.js';
export { supportsInbound, supportsPrompt } from './inbound.js';

// Channel adapters
export {
  BoardChannel,
  SlackOutputChannel, type SlackOutputChannelConfig,
  TelegramChannel, type TelegramChannelConfig,
  WebhookChannel,
} from './channels/index.js';
