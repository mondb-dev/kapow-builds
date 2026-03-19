// ── Core Tool Types (shared across all agents) ──────────────────────

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
  usage: string;              // example invocation
  parameters: string;         // formatted parameter docs
  returns: string;            // what to expect back
  examples: string[];         // concrete usage examples
  caveats: string[];          // gotchas, limitations
  relatedTools: string[];     // IDs of related tools
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
  doc: ToolDoc;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ── Tool Request: what an agent sends when it needs a capability ─────

export interface ToolRequest {
  runId: string;
  requestingAgent: string;      // 'builder' | 'qa' | 'planner' | 'gate'
  need: string;                 // what capability is needed
  context: string;              // why — which task, what's being built
  preferredTags?: string[];     // hint for matching existing tools
  urgency: 'blocking' | 'nice-to-have';
}

// ── Tool Request Result ──────────────────────────────────────────────

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

// ── Claude Tool Format (for injecting into agent tool lists) ─────────

export interface ClaudeToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}
