import { getAI } from 'kapow-shared';
import type { ToolDefinition, ToolDoc } from './types.js';
import { loadTools } from './registry.js';

const { provider, models } = getAI();

const SYSTEM_PROMPT = `You are the Documentation Agent for the Kapow tool registry.

Given a tool definition, generate comprehensive documentation that any agent in the pipeline can use to understand and correctly invoke the tool.

Return a JSON object with exactly these fields:
- summary: string (1-2 sentences explaining what the tool does and when to use it)
- usage: string (a single-line example invocation showing the most common use case)
- parameters: string (formatted parameter documentation, one per line with type, required/optional, and description)
- returns: string (what the tool returns, including the shape of the return value)
- examples: string[] (3-5 concrete, realistic usage examples with different parameter combinations)
- caveats: string[] (important warnings, limitations, prerequisites, edge cases — things an agent MUST know to avoid errors)
- relatedTools: string[] (IDs of tools that complement this one or are alternatives)

Documentation rules:
- Be precise and unambiguous — agents will read this programmatically
- Examples should be realistic, not toy examples
- Caveats should include: required env vars, size limits, timeout behavior, error conditions
- Related tools should only reference tools that actually exist in the registry`;

export async function generateDoc(tool: ToolDefinition): Promise<ToolDoc> {
  // Get existing tools for relatedTools references
  const allTools = loadTools().filter((t) => t.status === 'ready' && t.id !== tool.id);
  const toolIndex = allTools.map((t) => `[${t.id}] ${t.name}: ${t.description}`).join('\n');

  const response = await provider.chat({
    model: models.balanced,
    maxTokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Generate documentation for this tool:\n\nName: ${tool.name}\nDescription: ${tool.description}\nParameters: ${JSON.stringify(tool.parameters, null, 2)}\nReturn type: ${tool.returnType}\nTags: ${tool.tags.join(', ')}\nImplementation reference: ${tool.implementation.slice(0, 200)}\n\nOther tools in registry (for relatedTools):\n${toolIndex || '(none)'}`,
    }],
  });

  const text = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const doc = JSON.parse(jsonMatch[1]!.trim()) as ToolDoc;

  return {
    summary: doc.summary ?? tool.description,
    usage: doc.usage ?? `${tool.name}({})`,
    parameters: doc.parameters ?? '',
    returns: doc.returns ?? tool.returnType,
    examples: doc.examples ?? [],
    caveats: doc.caveats ?? [],
    relatedTools: doc.relatedTools ?? [],
  };
}
