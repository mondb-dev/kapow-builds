import { VertexAI, SchemaType, type Content, type Part, type FunctionDeclaration, type Tool } from '@google-cloud/vertexai';
import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';
import type { AIProvider, AIMessage, AIToolDef, AIResponse, AIContentBlock } from './types.js';

function getEnv(key: string): string | undefined {
  const serviceName = process.env.SERVICE_NAME?.trim().toUpperCase().replace(/-/g, '_');
  if (serviceName) {
    const scoped = process.env[`${serviceName}_${key}`];
    if (scoped) return scoped;
  }
  return process.env[key];
}

// ── Claude-on-Vertex client (token-refreshing) ───────────────────────

class ClaudeVertexClient {
  private auth: GoogleAuth;
  private project: string;
  private location: string;
  private cachedToken: string | null = null;
  private tokenExpiry = 0;

  constructor(project: string, location: string) {
    this.project = project;
    this.location = location;
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.cachedToken;
    }
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error('Failed to get GCP access token for Claude on Vertex');
    this.cachedToken = token;
    // GCP tokens are valid for 1 hour; refresh 1 min before expiry
    this.tokenExpiry = Date.now() + 59 * 60 * 1000;
    return token;
  }

  async chat(params: {
    model: string;
    system?: string;
    messages: AIMessage[];
    tools?: AIToolDef[];
    maxTokens?: number;
  }): Promise<AIResponse> {
    const token = await this.getToken();
    // Vertex Claude endpoint: model is in the URL, body is standard Anthropic Messages format
    const url = `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}/locations/${this.location}/publishers/anthropic/models/${params.model}:rawPredict`;

    const messages = params.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => {
            if (b.type === 'text') return { type: 'text', text: b.text };
            if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
            if (b.type === 'tool_result') return {
              type: 'tool_result',
              tool_use_id: b.tool_use_id,
              content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
            };
            return { type: 'text', text: JSON.stringify(b) };
          }),
    }));

    const body: Record<string, unknown> = {
      anthropic_version: 'vertex-2023-10-16',
      max_tokens: params.maxTokens ?? 8192,
      messages,
      ...(params.system ? { system: params.system } : {}),
      ...(params.tools?.length ? {
        tools: params.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
      } : {}),
    };

    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 120_000,
    });

    const response = res.data;
    const content: AIContentBlock[] = (response.content ?? []).map((b: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }): AIContentBlock => {
      if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} };
      return { type: 'text', text: JSON.stringify(b) };
    });

    const stopReason =
      response.stop_reason === 'tool_use' ? 'tool_use'
      : response.stop_reason === 'end_turn' ? 'end_turn'
      : response.stop_reason === 'max_tokens' ? 'max_tokens'
      : 'other';

    return {
      content,
      stopReason,
      usage: response.usage ? {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
      } : undefined,
    };
  }
}

// ── VertexProvider — routes claude-* to Anthropic, rest to Gemini ────

export class VertexProvider implements AIProvider {
  readonly name = 'vertex';
  private gemini: VertexAI;
  private claude: ClaudeVertexClient;
  private location: string;

  constructor(project?: string, location?: string) {
    const resolvedProject = project ?? getEnv('GOOGLE_CLOUD_PROJECT') ?? getEnv('GCLOUD_PROJECT');
    if (!resolvedProject) throw new Error('GOOGLE_CLOUD_PROJECT is required for Vertex AI');
    this.location = location ?? getEnv('GOOGLE_CLOUD_LOCATION') ?? 'us-central1';
    this.gemini = new VertexAI({ project: resolvedProject, location: this.location });
    this.claude = new ClaudeVertexClient(resolvedProject, this.location);
  }

  async chat(params: {
    model: string;
    system?: string;
    messages: AIMessage[];
    tools?: AIToolDef[];
    maxTokens?: number;
  }): Promise<AIResponse> {
    if (params.model.startsWith('claude-')) {
      return this.claude.chat(params);
    }
    return this.geminiChat(params);
  }

  private async geminiChat(params: {
    model: string;
    system?: string;
    messages: AIMessage[];
    tools?: AIToolDef[];
    maxTokens?: number;
  }): Promise<AIResponse> {
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

    const model = this.gemini.getGenerativeModel({
      model: params.model,
      systemInstruction: params.system,
      generationConfig: { maxOutputTokens: params.maxTokens ?? 8192 },
      ...(geminiTools ? { tools: geminiTools } : {}),
    });

    const contents: Content[] = [];
    for (const msg of params.messages) {
      const parts: Part[] = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') parts.push({ text: block.text });
          else if (block.type === 'tool_use') parts.push({ functionCall: { name: block.name, args: block.input } });
          else if (block.type === 'tool_result') parts.push({ functionResponse: { name: block.tool_use_id, response: { result: block.content } } });
        }
      }
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
    }

    const result = await model.generateContent({ contents });
    const response = result.response;
    const firstCandidate = (response.candidates ?? [])[0];
    if (!firstCandidate) return { content: [{ type: 'text', text: '' }], stopReason: 'other' };

    const parts = firstCandidate.content?.parts;
    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      return { content: [{ type: 'text', text: `[Vertex returned empty response: ${firstCandidate.finishReason ?? 'unknown'}]` }], stopReason: 'other' };
    }

    const content: AIContentBlock[] = [];
    let hasToolCalls = false;
    for (const part of parts) {
      if (part.text) content.push({ type: 'text', text: part.text });
      if (part.functionCall) {
        hasToolCalls = true;
        content.push({ type: 'tool_use', id: `call-${part.functionCall.name}-${Date.now()}`, name: part.functionCall.name, input: (part.functionCall.args ?? {}) as Record<string, unknown> });
      }
    }

    const finishReason = firstCandidate.finishReason;
    return {
      content,
      stopReason: hasToolCalls ? 'tool_use' : finishReason === 'STOP' ? 'end_turn' : finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'other',
      usage: response.usageMetadata ? { inputTokens: response.usageMetadata.promptTokenCount ?? 0, outputTokens: response.usageMetadata.candidatesTokenCount ?? 0 } : undefined,
    };
  }
}
