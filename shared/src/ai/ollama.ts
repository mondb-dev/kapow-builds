/**
 * Ollama Provider — local LLM inference via Ollama API.
 *
 * Used for recipe-matched tasks where reasoning is cheap
 * because the recipe already tells the model what to do.
 *
 * Supports tool-use via Ollama's OpenAI-compatible endpoint.
 */
import type { AIProvider, AIMessage, AIToolDef, AIResponse, AIContentBlock } from './types.js';

const DEFAULT_URL = 'http://localhost:11434';

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  done: boolean;
  eval_count?: number;
  prompt_eval_count?: number;
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.OLLAMA_URL ?? DEFAULT_URL;
  }

  async chat(params: {
    model: string;
    system?: string;
    messages: AIMessage[];
    tools?: AIToolDef[];
    maxTokens?: number;
  }): Promise<AIResponse> {
    // Convert messages to Ollama format
    const messages: OllamaChatMessage[] = [];

    if (params.system) {
      messages.push({ role: 'system', content: params.system });
    }

    for (const msg of params.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else {
        // Handle content blocks
        const textParts: string[] = [];
        const toolCalls: OllamaChatMessage['tool_calls'] = [];
        const toolResults: { tool_call_id: string; content: string }[] = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          } else if (block.type === 'tool_result') {
            toolResults.push({
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }

        if (msg.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: textParts.join('\n'),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        } else {
          // User message with tool results
          if (toolResults.length > 0) {
            for (const tr of toolResults) {
              messages.push({
                role: 'tool',
                content: tr.content,
                tool_call_id: tr.tool_call_id,
              });
            }
          }
          if (textParts.length > 0) {
            messages.push({ role: 'user', content: textParts.join('\n') });
          }
        }
      }
    }

    // Convert tools to Ollama format
    const tools: OllamaTool[] | undefined = params.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object' as const,
          properties: t.input_schema.properties,
          required: t.input_schema.required,
        },
      },
    }));

    const body = {
      model: params.model,
      messages,
      stream: false,
      options: {
        num_predict: params.maxTokens ?? 8192,
      },
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as OllamaChatResponse;
    const content: AIContentBlock[] = [];
    let hasToolCalls = false;

    // Parse text content
    if (data.message.content) {
      content.push({ type: 'text', text: data.message.content });
    }

    // Parse tool calls
    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      hasToolCalls = true;
      for (const tc of data.message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id ?? `call-${tc.function.name}-${Date.now()}`,
          name: tc.function.name,
          input: args,
        });
      }
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      content,
      stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
    };
  }
}
