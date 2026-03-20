import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AIMessage, AIToolDef, AIResponse, AIContentBlock } from './types.js';

function getScopedKey(name: string): string | undefined {
  const serviceName = process.env.SERVICE_NAME?.trim().toUpperCase().replace(/-/g, '_');
  if (!serviceName) return undefined;
  return process.env[`${serviceName}_${name}`];
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? getScopedKey('ANTHROPIC_API_KEY') ?? process.env.ANTHROPIC_API_KEY,
    });
  }

  async chat(params: {
    model: string;
    system?: string;
    messages: AIMessage[];
    tools?: AIToolDef[];
    maxTokens?: number;
  }): Promise<AIResponse> {
    // Convert our messages to Anthropic format
    const messages: Anthropic.MessageParam[] = params.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => {
            if (b.type === 'text') return { type: 'text' as const, text: b.text };
            if (b.type === 'tool_use') return { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input };
            if (b.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: b.tool_use_id, content: b.content };
            return { type: 'text' as const, text: '' };
          }),
    }));

    const tools: Anthropic.Tool[] | undefined = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 8192,
      system: params.system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    // Convert response to our format
    const content: AIContentBlock[] = response.content.map((b) => {
      if (b.type === 'text') return { type: 'text' as const, text: b.text };
      if (b.type === 'tool_use') return {
        type: 'tool_use' as const,
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      };
      return { type: 'text' as const, text: '' };
    });

    const stopReason = response.stop_reason === 'tool_use' ? 'tool_use'
      : response.stop_reason === 'end_turn' ? 'end_turn'
      : response.stop_reason === 'max_tokens' ? 'max_tokens'
      : 'other';

    return {
      content,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
