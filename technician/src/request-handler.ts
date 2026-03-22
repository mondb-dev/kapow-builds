import { getAI } from 'kapow-shared';
import { findRelevantTools } from 'kapow-db/tools';
import { loadTools, upsertTool } from './registry.js';
import { researchTool } from './researcher.js';
import { buildTool } from './implementer.js';
import { generateDoc } from './doc-generator.js';
import type {
  ToolRequest, ToolRequestResult, ToolRequestOutcome,
  ToolDefinition, ResearchResult,
} from './types.js';

const { provider, models } = getAI();

const TRIAGE_PROMPT = `You are the Technician Triage Agent for the Kapow development pipeline.

An agent has requested a tool capability. You must decide the best course of action.

Given:
1. The agent's need (what capability they want)
2. The existing tool registry (all available tools)
3. The context (why they need it)

Decide ONE of these actions:

- "found_existing": An existing READY tool already satisfies this need. Return its ID.
- "update_existing": An existing tool partially covers this but needs enhancement. Return its ID and what needs to change.
- "decouple": An existing tool is too complex and should be split. Return its ID and how to split it.
- "create_new": No existing tool covers this. A new tool is needed.

Respond with ONLY a JSON object:
{
  "action": "found_existing" | "update_existing" | "decouple" | "create_new",
  "toolId": "id-of-existing-tool (if applicable)",
  "reasoning": "why this decision",
  "updateSpec": "what to change (for update_existing)",
  "decoupleSpec": ["tool1 desc", "tool2 desc"] (for decouple)
}`;

export async function handleToolRequest(request: ToolRequest): Promise<ToolRequestResult> {
  const { runId } = request;

  try {
    // Step 0: Quick vector search — if a close match exists, return it immediately
    try {
      const vectorMatches = await findRelevantTools(request.need, 1);
      if (vectorMatches.length > 0) {
        const match = vectorMatches[0];
        console.log(`[${runId}] Vector match found: ${match.name} — skipping LLM triage`);
        return { runId, outcome: { action: 'found_existing', tool: match } };
      }
    } catch (err) {
      console.error(`[${runId}] Vector search failed, falling back to LLM triage:`, err instanceof Error ? err.message : err);
    }

    // Step 1: Triage — decide what to do (LLM-based)
    const existingTools = (await loadTools()).filter((t) => t.status === 'ready');
    const decision = await triageRequest(request, existingTools);

    console.log(`[${runId}] Triage decision: ${decision.action} (${decision.reasoning.slice(0, 100)})`);

    let outcome: ToolRequestOutcome;

    switch (decision.action) {
      case 'found_existing': {
        const tool = existingTools.find((t) => t.id === decision.toolId);
        if (!tool) {
          outcome = { action: 'failed', error: `Triage referenced tool ${decision.toolId} but it was not found` };
        } else {
          outcome = { action: 'found_existing', tool };
        }
        break;
      }

      case 'update_existing': {
        const existing = existingTools.find((t) => t.id === decision.toolId);
        if (!existing) {
          // Fall through to create new
          outcome = await createNewTool(runId, request);
        } else {
          outcome = await updateExistingTool(runId, existing, decision.updateSpec ?? '', request);
        }
        break;
      }

      case 'decouple': {
        const existing = existingTools.find((t) => t.id === decision.toolId);
        if (!existing) {
          outcome = await createNewTool(runId, request);
        } else {
          outcome = await decoupleTool(runId, existing, decision.decoupleSpec ?? [], request);
        }
        break;
      }

      case 'create_new':
      default: {
        outcome = await createNewTool(runId, request);
        break;
      }
    }

    return { runId, outcome };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${runId}] Tool request failed:`, msg);
    return { runId, outcome: { action: 'failed', error: msg } };
  }
}

// ── Triage: ask Claude to decide ─────────────────────────────────────

interface TriageDecision {
  action: 'found_existing' | 'update_existing' | 'decouple' | 'create_new';
  toolId?: string;
  reasoning: string;
  updateSpec?: string;
  decoupleSpec?: string[];
}

async function triageRequest(request: ToolRequest, existingTools: ToolDefinition[]): Promise<TriageDecision> {
  const toolSummary = existingTools.map((t) =>
    `- [${t.id}] ${t.name}: ${t.description} (tags: ${t.tags.join(', ')})`
  ).join('\n');

  const response = await provider.chat({
    model: models.balanced,
    maxTokens: 2048,
    system: TRIAGE_PROMPT,
    messages: [{
      role: 'user',
      content: `Agent: ${request.requestingAgent}\nNeed: ${request.need}\nContext: ${request.context}\nUrgency: ${request.urgency}\nPreferred tags: ${request.preferredTags?.join(', ') || 'none'}\n\nExisting tools (${existingTools.length}):\n${toolSummary || '(none)'}`,
    }],
  });

  const text = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  return JSON.parse(jsonMatch[1]!.trim()) as TriageDecision;
}

// ── Create New Tool ──────────────────────────────────────────────────

async function createNewTool(runId: string, request: ToolRequest): Promise<ToolRequestOutcome> {
  console.log(`[${runId}] Creating new tool for: ${request.need.slice(0, 100)}`);

  // Research
  const existingIds = (await loadTools()).map((t) => t.id);
  const research = await researchTool({
    runId,
    need: request.need,
    context: `${request.requestingAgent}: ${request.context}`,
    existingTools: existingIds,
  });

  // Build
  const buildResult = await buildTool({ runId, research });

  if (!buildResult.success) {
    return { action: 'failed', error: `Build failed: ${buildResult.error}` };
  }

  // Generate documentation
  const doc = await generateDoc(buildResult.tool);
  buildResult.tool.doc = doc;
  upsertTool(buildResult.tool);

  console.log(`[${runId}] New tool published: ${buildResult.tool.name} (${buildResult.toolId})`);
  return { action: 'created_new', tool: buildResult.tool };
}

// ── Update Existing Tool ─────────────────────────────────────────────

async function updateExistingTool(
  runId: string,
  existing: ToolDefinition,
  updateSpec: string,
  request: ToolRequest
): Promise<ToolRequestOutcome> {
  console.log(`[${runId}] Updating tool ${existing.id}: ${updateSpec.slice(0, 100)}`);

  // Research the update as a new tool with existing context
  const research = await researchTool({
    runId,
    need: `Update the existing "${existing.name}" tool: ${updateSpec}. Original description: ${existing.description}. New requirement from ${request.requestingAgent}: ${request.need}`,
    context: request.context,
    existingTools: (await loadTools()).map((t) => t.id),
  });

  // Build updated version
  const buildResult = await buildTool({ runId, research });

  if (!buildResult.success) {
    // Return the existing tool if update fails — it still partially works
    return { action: 'found_existing', tool: existing };
  }

  // Merge: keep the old ID, bump version
  const updated: ToolDefinition = {
    ...buildResult.tool,
    id: existing.id,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    createdBy: existing.createdBy,
  };

  // Generate fresh docs
  updated.doc = await generateDoc(updated);
  upsertTool(updated);

  const changelog = `v${existing.version} → v${updated.version}: ${updateSpec}`;
  console.log(`[${runId}] Tool updated: ${updated.name} (${changelog})`);
  return { action: 'updated_existing', tool: updated, changelog };
}

// ── Decouple Tool ────────────────────────────────────────────────────

async function decoupleTool(
  runId: string,
  existing: ToolDefinition,
  specs: string[],
  request: ToolRequest
): Promise<ToolRequestOutcome> {
  console.log(`[${runId}] Decoupling tool ${existing.id} into ${specs.length} parts`);

  const newTools: ToolDefinition[] = [];

  for (const spec of specs) {
    const research = await researchTool({
      runId,
      need: spec,
      context: `Decoupled from "${existing.name}": ${existing.description}. Requested by ${request.requestingAgent}: ${request.context}`,
      existingTools: (await loadTools()).map((t) => t.id),
    });

    const buildResult = await buildTool({ runId, research });
    if (buildResult.success) {
      buildResult.tool.doc = await generateDoc(buildResult.tool);
      upsertTool(buildResult.tool);
      newTools.push(buildResult.tool);
    }
  }

  if (newTools.length === 0) {
    return { action: 'failed', error: 'All decoupled tool builds failed' };
  }

  // Deprecate the original
  existing.status = 'deprecated';
  existing.doc = {
    ...existing.doc,
    summary: `DEPRECATED — decoupled into: ${newTools.map((t) => t.name).join(', ')}`,
  };
  upsertTool(existing);

  const explanation = `"${existing.name}" was too broad. Split into: ${newTools.map((t) => `${t.name} (${t.description})`).join('; ')}`;
  console.log(`[${runId}] Decoupled: ${explanation}`);
  return { action: 'decoupled', tools: newTools, explanation };
}
