// ── Tool Registry Types ──────────────────────────────────────────────

export type ToolStatus = 'researching' | 'building' | 'testing' | 'ready' | 'failed' | 'deprecated';

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
}

export interface ToolDoc {
  summary: string;
  usage?: string;
  parameters?: string;
  returns?: string;
  examples?: string[];
  caveats?: string[];
  relatedTools?: string[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  status: ToolStatus;
  parameters: ToolParameter[];
  returnType: string;
  implementation: string;
  testCode: string;
  tags: string[];
  doc: ToolDoc | null;
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// ── Research Agent Types ─────────────────────────────────────────────

export interface ResearchRequest {
  runId: string;
  need: string;
  context: string;
  existingTools: string[];
}

export interface ResearchResult {
  runId: string;
  toolName: string;
  description: string;
  parameters: ToolParameter[];
  returnType: string;
  approach: string;
  dependencies: string[];
  risks: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

// ── Implementation Agent Types ───────────────────────────────────────

export interface BuildToolRequest {
  runId: string;
  research: ResearchResult;
}

export interface BuildToolResult {
  runId: string;
  toolId: string;
  tool: ToolDefinition;
  success: boolean;
  testOutput: string;
  error?: string;
}

// ── Registry Query Types ─────────────────────────────────────────────

export interface ToolQuery {
  tags?: string[];
  status?: ToolStatus;
  search?: string;
}

// ── Tool Request (from any agent) ────────────────────────────────────

export interface ToolRequest {
  runId: string;
  requestingAgent: string;
  need: string;
  context: string;
  preferredTags?: string[];
  urgency: 'blocking' | 'nice-to-have';
}

export type ToolRequestOutcome =
  | { action: 'found_existing'; tool: ToolDefinition }
  | { action: 'created_new'; tool: ToolDefinition }
  | { action: 'updated_existing'; tool: ToolDefinition; changelog: string }
  | { action: 'decoupled'; tools: ToolDefinition[]; explanation: string }
  | { action: 'failed'; error: string };

export interface ToolRequestResult {
  runId: string;
  outcome: ToolRequestOutcome;
}
