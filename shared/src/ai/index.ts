export { getProvider, getModels, getAI } from './provider.js';
export { AnthropicProvider } from './anthropic.js';
export { GeminiProvider } from './gemini.js';
export type { AIProvider, AIMessage, AIContentBlock, AIToolDef, AIResponse, ModelMap } from './types.js';
export { embed, embedBatch, toPgVector, EMBEDDING_DIM } from './embeddings.js';
