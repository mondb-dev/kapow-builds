import { GoogleGenerativeAI, SchemaType, type Content, type Part, type FunctionDeclaration, type Tool } from '@google/generative-ai';
import type { AIProvider, AIMessage, AIToolDef, AIResponse, AIContentBlock } from './types.js';

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  private client: GoogleGenerativeAI;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required');
    this.client = new GoogleGenerativeAI(key);
  }

  async chat(params: {
    model: string;
    system?: string;
    messages: AIMessage[];
    tools?: AIToolDef[];
    maxTokens?: number;
  }): Promise<AIResponse> {
    // Convert tools to Gemini format
    const geminiTools: Tool[] | undefined = params.tools && params.tools.length > 0
      ? [{
          functionDeclarations: params.tools.map((t): FunctionDeclaration => ({
            name: t.name,
            description: t.description,
            parameters: {
              type: SchemaType.OBJECT,
              properties: Object.fromEntries(
                Object.entries(t.input_schema.properties).map(([k, v]) => [
                  k,
                  { type: v.type as SchemaType, description: v.description },
                ])
              ),
              required: t.input_schema.required,
            } as unknown as FunctionDeclaration['parameters'],
          })),
        }]
      : undefined;

    const model = this.client.getGenerativeModel({
      model: params.model,
      systemInstruction: params.system,
      generationConfig: {
        maxOutputTokens: params.maxTokens ?? 8192,
      },
      ...(geminiTools ? { tools: geminiTools } : {}),
    });

    // Convert messages to Gemini format
    const contents: Content[] = [];
    for (const msg of params.messages) {
      const parts: Part[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            parts.push({
              functionCall: { name: block.name, args: block.input },
            });
          } else if (block.type === 'tool_result') {
            parts.push({
              functionResponse: {
                name: block.tool_use_id,
                response: { result: block.content },
              },
            });
          }
        }
      }

      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }

    const result = await model.generateContent({ contents });
    const response = result.response;
    const candidates = response.candidates ?? [];
    const firstCandidate = candidates[0];

    if (!firstCandidate) {
      return { content: [{ type: 'text', text: '' }], stopReason: 'other' };
    }

    // Convert response to our format
    const content: AIContentBlock[] = [];
    let hasToolCalls = false;

    for (const part of firstCandidate.content.parts) {
      if (part.text) {
        content.push({ type: 'text', text: part.text });
      }
      if (part.functionCall) {
        hasToolCalls = true;
        content.push({
          type: 'tool_use',
          id: `call-${part.functionCall.name}-${Date.now()}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    const finishReason = firstCandidate.finishReason;
    const stopReason = hasToolCalls ? 'tool_use'
      : finishReason === 'STOP' ? 'end_turn'
      : finishReason === 'MAX_TOKENS' ? 'max_tokens'
      : 'other';

    return {
      content,
      stopReason,
      usage: response.usageMetadata ? {
        inputTokens: response.usageMetadata.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
      } : undefined,
    };
  }
}
