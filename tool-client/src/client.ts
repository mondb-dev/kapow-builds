import axios from 'axios';
import type {
  ToolDefinition,
  ToolRequest,
  ToolRequestResult,
  ClaudeToolDef,
} from './types.js';

export class ToolClient {
  private baseUrl: string;
  private agent: string;

  constructor(agent: string, technicianUrl?: string) {
    this.agent = agent;
    this.baseUrl = technicianUrl ?? process.env.TECHNICIAN_URL ?? 'http://localhost:3006';
  }

  // ── Discovery ──────────────────────────────────────────────────────

  /** Get all tools with status 'ready' */
  async getReadyTools(): Promise<ToolDefinition[]> {
    const res = await axios.get<ToolDefinition[]>(`${this.baseUrl}/tools/ready`, { timeout: 10_000 });
    return res.data;
  }

  /** Search tools by tags, status, or free text */
  async searchTools(query: { tags?: string[]; status?: string; search?: string }): Promise<ToolDefinition[]> {
    const params = new URLSearchParams();
    if (query.tags) params.set('tags', query.tags.join(','));
    if (query.status) params.set('status', query.status);
    if (query.search) params.set('search', query.search);
    const res = await axios.get<ToolDefinition[]>(`${this.baseUrl}/tools?${params}`, { timeout: 10_000 });
    return res.data;
  }

  /** Get a specific tool by ID */
  async getTool(id: string): Promise<ToolDefinition | null> {
    try {
      const res = await axios.get<ToolDefinition>(`${this.baseUrl}/tools/${id}`, { timeout: 10_000 });
      return res.data;
    } catch {
      return null;
    }
  }

  // ── Request a tool (the core flow) ─────────────────────────────────

  /**
   * Request a capability from the technician.
   * The technician will:
   * 1. Check if an existing ready tool satisfies the need
   * 2. If yes → return it
   * 3. If partially → update or decouple it
   * 4. If no → research + build + test + publish a new tool
   */
  async requestTool(
    runId: string,
    need: string,
    context: string,
    options?: { preferredTags?: string[]; urgency?: 'blocking' | 'nice-to-have' }
  ): Promise<ToolRequestResult> {
    const request: ToolRequest = {
      runId,
      requestingAgent: this.agent,
      need,
      context,
      preferredTags: options?.preferredTags,
      urgency: options?.urgency ?? 'blocking',
    };

    const res = await axios.post<ToolRequestResult>(
      `${this.baseUrl}/request-tool`,
      request,
      { timeout: 300_000 } // tool creation can take time
    );
    return res.data;
  }

  // ── Format tools for Claude API ────────────────────────────────────

  /**
   * Convert registry tools to Claude tool_use format.
   * Agents inject these into their Claude API calls so the model
   * can discover and use shared tools alongside built-in ones.
   */
  static toClaudeTools(tools: ToolDefinition[]): ClaudeToolDef[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: `${tool.description}\n\n${tool.doc?.usage ?? ''}`.trim(),
      input_schema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          tool.parameters.map((p) => [
            p.name,
            { type: p.type, description: p.description },
          ])
        ),
        required: tool.parameters.filter((p) => p.required).map((p) => p.name),
      },
    }));
  }

  /**
   * Generate a documentation block for injecting into system prompts.
   * Gives agents full awareness of what tools are available.
   */
  static formatToolDocs(tools: ToolDefinition[]): string {
    if (tools.length === 0) return '';

    const sections = tools.map((t) => {
      const params = t.parameters
        .map((p) => `  - ${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
        .join('\n');

      const examples = (t.doc?.examples ?? []).map((e) => `  ${e}`).join('\n');
      const caveats = (t.doc?.caveats ?? []).map((c) => `  ⚠ ${c}`).join('\n');

      return [
        `### ${t.name} (v${t.version})`,
        t.description,
        '',
        'Parameters:',
        params || '  (none)',
        '',
        `Returns: ${t.returnType}`,
        examples ? `\nExamples:\n${examples}` : '',
        caveats ? `\nCaveats:\n${caveats}` : '',
      ].filter(Boolean).join('\n');
    });

    return `=== SHARED TOOL REGISTRY (${tools.length} tools available) ===\n\n${sections.join('\n\n---\n\n')}\n\n=== END TOOL REGISTRY ===`;
  }
}
