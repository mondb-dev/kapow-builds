export * from './types.js';
export { KAPOW_IDENTITY, KAPOW_LINES, withPersona } from './persona.js';
export { createAgent, type Agent, type AgentConfig } from './agent-base.js';
export { MessageBus, getBus, BusClient, BusTopics } from './bus/index.js';
export type { BusMessage, FileAttachment, MessageHandler, BusTopic } from './bus/index.js';
export {
  INTERNAL_AUTH_HEADER,
  getInternalApiKey,
  getInternalAuthHeaders,
  isInternalRequestAuthorized,
} from './internal-auth.js';
export { CommsBus, BoardChannel, WebhookChannel, TelegramChannel, SlackOutputChannel } from './comms/index.js';
export type {
  OutputChannel, TaskCreatePayload, TaskRecord,
  TaskStatus, TaskOutput, EventSeverity,
  WebhookChannelConfig, TelegramChannelConfig, SlackOutputChannelConfig,
  IOChannel, InboundHandler, InboundMessage, InboundAttachment,
  InboundChannelKind, PromptKind, PromptButton, PromptRequest,
  PromptHandle, InboundReply,
} from './comms/index.js';
export { supportsInbound, supportsPrompt } from './comms/index.js';
export { getProvider, getModels, getAI, getLocalAI, AnthropicProvider, GeminiProvider, OllamaProvider } from './ai/index.js';
export type { AIProvider, AIMessage, AIContentBlock, AIToolDef, AIResponse, ModelMap } from './ai/index.js';
export { embed, embedBatch, toPgVector, EMBEDDING_DIM } from './ai/embeddings.js';
