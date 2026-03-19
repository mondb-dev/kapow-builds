import { getAI } from 'kapow-shared';
import type { ResearchRequest, ResearchResult, ToolParameter } from './types.js';
import { loadTools } from './registry.js';

const { provider, models } = getAI();

const SYSTEM_PROMPT = `You are the Research Agent — the first half of the Technician team.

Your job: Given a capability need from the Kapow agent stack, research and design a tool specification.

You DO NOT implement — that is the Implementer's job. You produce a precise specification that the Implementer can build from.

Your output must be a JSON object with exactly these fields:
- toolName: string (snake_case, concise, descriptive)
- description: string (what the tool does, when to use it)
- parameters: array of { name, type, description, required }
- returnType: string (what the tool returns)
- approach: string (implementation strategy — libraries, algorithms, key decisions)
- dependencies: string[] (npm packages needed, empty array if none)
- risks: string[] (security concerns, failure modes, edge cases)
- estimatedComplexity: "low" | "medium" | "high"

Guidelines:
- Design tools that are GENERAL PURPOSE — reusable across agents, not tied to one task.
- Keep parameters minimal. A tool that needs 10 parameters is probably 3 tools.
- Prefer existing Node.js built-ins and well-maintained packages.
- Consider security: tools should not expose secrets, allow arbitrary code execution without sandboxing, or bypass access controls.
- Check existing tools to avoid duplication. If an existing tool partially covers the need, suggest extending it instead of creating a new one.`;

export async function researchTool(request: ResearchRequest): Promise<ResearchResult> {
  const existingTools = loadTools();
  const existingContext = existingTools.length > 0
    ? `\n\nExisting tools in the registry:\n${existingTools.map((t) => `- ${t.name}: ${t.description} [${t.status}]`).join('\n')}`
    : '\n\nNo existing tools in the registry.';

  const response = await provider.chat({
    model: models.balanced,
    maxTokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Capability needed: ${request.need}\n\nContext: ${request.context}\n\nExisting tool IDs to avoid duplicating: ${request.existingTools.join(', ') || 'none'}${existingContext}\n\nRespond with ONLY the JSON specification object.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const spec = JSON.parse(jsonMatch[1]!.trim());

  return {
    runId: request.runId,
    toolName: spec.toolName,
    description: spec.description,
    parameters: spec.parameters as ToolParameter[],
    returnType: spec.returnType,
    approach: spec.approach,
    dependencies: spec.dependencies ?? [],
    risks: spec.risks ?? [],
    estimatedComplexity: spec.estimatedComplexity ?? 'medium',
  };
}
