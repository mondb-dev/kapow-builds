/**
 * AI Provider Interface
 *
 * Abstract interface for LLM providers. All agents use this
 * instead of importing a specific SDK directly.
 *
 * Switch providers via AI_PROVIDER env var:
 *   AI_PROVIDER=anthropic  (default)
 *   AI_PROVIDER=gemini
 *   AI_PROVIDER=openai     (future)
 */

// ── Message Types ────────────────────────────────────────────────────

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string | AIContentBlock[];
}

export type AIContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// ── Tool Definition ──────────────────────────────────────────────────

export interface AIToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// ── Response ─────────────────────────────────────────────────────────

export interface AIResponse {
  content: AIContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ── Provider Interface ───────────────────────────────────────────────

export interface AIProvider {
  readonly name: string;

  /**
   * Send a message and get a response.
   * This is the core method all agents call.
   */
  chat(params: {
    model: string;
    system?: string;
    messages: AIMessage[];
    tools?: AIToolDef[];
    maxTokens?: number;
  }): Promise<AIResponse>;
}

// ── Model Mapping ────────────────────────────────────────────────────

export interface ModelMap {
  /** High capability (builder) — Claude Opus / Gemini 2.5 Pro */
  strong: string;
  /** Medium capability (planner, qa, technician, security) — Claude Sonnet / Gemini 2.5 Flash */
  balanced: string;
  /** Fast/cheap (gate, intent detection) — Claude Haiku / Gemini 2.0 Flash */
  fast: string;
}
