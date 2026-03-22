/**
 * AI Provider Factory
 *
 * Creates the right provider based on AI_PROVIDER env var.
 * Also provides model name mapping so agents use logical names
 * (strong/balanced/fast) instead of provider-specific model IDs.
 */
import type { AIProvider, ModelMap } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

// ── Model Maps ───────────────────────────────────────────────────────

const ANTHROPIC_MODELS: ModelMap = {
  strong: 'claude-opus-4-6',
  balanced: 'claude-sonnet-4-6',
  fast: 'claude-haiku-4-5-20251001',
};

const GEMINI_MODELS: ModelMap = {
  strong: 'gemini-2.5-pro',
  balanced: 'gemini-2.5-flash',
  fast: 'gemini-2.5-flash',
};

// Allow overrides via env — service-scoped keys take priority
function getScopedModel(key: string): string | undefined {
  const serviceName = process.env.SERVICE_NAME?.trim().toUpperCase().replace(/-/g, '_');
  if (!serviceName) return undefined;
  return process.env[`${serviceName}_${key}`];
}

function loadModelMap(defaults: ModelMap): ModelMap {
  return {
    strong: getScopedModel('AI_MODEL_STRONG') ?? process.env.AI_MODEL_STRONG ?? defaults.strong,
    balanced: getScopedModel('AI_MODEL_BALANCED') ?? process.env.AI_MODEL_BALANCED ?? defaults.balanced,
    fast: getScopedModel('AI_MODEL_FAST') ?? process.env.AI_MODEL_FAST ?? defaults.fast,
  };
}

// ── Factory ──────────────────────────────────────────────────────────

let cachedProvider: AIProvider | null = null;
let cachedModels: ModelMap | null = null;

export function getProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;

  const providerName = (process.env.AI_PROVIDER ?? 'anthropic').toLowerCase();

  switch (providerName) {
    case 'gemini':
    case 'google':
      cachedProvider = new GeminiProvider();
      break;
    case 'anthropic':
    case 'claude':
    default:
      cachedProvider = new AnthropicProvider();
      break;
  }

  console.log(`[ai] Provider: ${cachedProvider.name}`);
  return cachedProvider;
}

export function getModels(): ModelMap {
  if (cachedModels) return cachedModels;

  const providerName = (process.env.AI_PROVIDER ?? 'anthropic').toLowerCase();

  switch (providerName) {
    case 'gemini':
    case 'google':
      cachedModels = loadModelMap(GEMINI_MODELS);
      break;
    case 'anthropic':
    case 'claude':
    default:
      cachedModels = loadModelMap(ANTHROPIC_MODELS);
      break;
  }

  return cachedModels;
}

/** Convenience: get provider + models in one call */
export function getAI(): { provider: AIProvider; models: ModelMap } {
  return { provider: getProvider(), models: getModels() };
}
