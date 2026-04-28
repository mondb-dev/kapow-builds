/**
 * Kapow Shared Types
 *
 * Single source of truth for all cross-service interfaces.
 * Every service imports from here — no local type definitions
 * for shared concepts.
 */

// ── Planning ─────────────────────────────────────────────────────────

export type TaskIntent =
  | 'development'    // build software: apps, scripts, configs, infrastructure
  | 'research'       // find, synthesize, and cite information from sources
  | 'writing'        // produce prose: articles, reports, copy, documentation
  | 'analysis'       // examine data/situations, produce structured findings
  | 'audit'          // evaluate an existing artifact against criteria
  | 'creative'       // generate artistic/design output: poems, stories, naming
  ;

export interface Task {
  id: string;
  description: string;
  intent: TaskIntent;
  type: 'code' | 'shell' | 'browser' | 'file' | 'api';
  dependencies: string[];
  acceptanceCriteria: string[];
}

export interface Phase {
  id: string;
  name: string;
  description: string;
  tasks: Task[];
  dependencies: string[];
}

export interface ProjectContext {
  overview: string;
  approach: string;
  structure: string;
  conventions: string;
  resolvedAmbiguities: string[];
  notes: string;
}

/** @deprecated Use ProjectContext instead */
export type ArchitectureDoc = ProjectContext;

export interface ProjectPlan {
  id: string;
  originalBrief: string;
  intent: TaskIntent;
  phases: Phase[];
  constraints: string[];
  architecture: ProjectContext;
}

// ── Building ─────────────────────────────────────────────────────────

export interface Artifact {
  path: string;
  type: 'file' | 'directory';
  content?: string;
}

export interface TaskBuildResult {
  runId: string;
  taskId: string;
  sandboxPath: string;
  artifacts: Artifact[];
  logs: string[];
  success: boolean;
}

export interface TaskBuildRequest {
  runId: string;
  task: Task;
  phase: Phase;
  architecture: ArchitectureDoc;
  constraints: string[];
  sandboxPath?: string;
  completedTasks: string[];
  availableTools?: AvailableTool[];
  useLocalAI?: boolean;
}

export interface TaskFixRequest {
  runId: string;
  task: Task;
  phase: Phase;
  architecture: ArchitectureDoc;
  constraints: string[];
  previousBuildResult: TaskBuildResult;
  delta: string;
  qaIssues?: Issue[];
  iteration: number;
}

// ── QA ───────────────────────────────────────────────────────────────

export interface Issue {
  severity: 'critical' | 'major' | 'minor';
  taskId: string;
  description: string;
  file?: string;
}

export interface TaskQAResult {
  runId: string;
  taskId: string;
  passed: boolean;
  issues: Issue[];
  delta: string;
}

export interface TaskQARequest {
  runId: string;
  task: Task;
  phase: Phase;
  architecture: ArchitectureDoc;
  buildResult: TaskBuildResult;
  previousQAResults?: TaskQAResult[];
  availableTools?: AvailableTool[];
}

// ── Gate ──────────────────────────────────────────────────────────────

export interface GateResult {
  runId: string;
  ciSignal: 'go' | 'no-go' | 'escalate';
  iteration: number;
  delta?: string;
  diagnosis?: string;
  artifacts?: Artifact[];
}

// ── Tool Registry ────────────────────────────────────────────────────

export interface AvailableTool {
  id: string;
  name: string;
  description: string;
  parameters: ToolParameter[];
  returnType: string;
  doc?: ToolDoc;
}

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
}

export interface ToolDoc {
  summary: string;
  usage: string;
  parameters: string;
  returns: string;
  examples: string[];
  caveats: string[];
  relatedTools: string[];
}

// ── Board ────────────────────────────────────────────────────────────

export interface BoardCard {
  id?: string;
  title: string;
  description: string;
  status: 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
  runId?: string;
  phaseId?: string;
  taskId?: string;
}

export interface BoardEvent {
  cardId: string;
  message: string;
  type: 'INFO' | 'SUCCESS' | 'ERROR' | 'PROGRESS';
}

// ── Pipeline ─────────────────────────────────────────────────────────

export interface PipelineState {
  runId: string;
  plan: string;
  projectPlan?: ProjectPlan;
  currentPhase?: string;
  currentTask?: string;
  iteration: number;
  status: 'pending' | 'planning' | 'building' | 'qa' | 'gate' | 'done' | 'failed';
}

export interface PipelineResult {
  success: boolean;
  artifacts?: Artifact[];
  diagnosis?: string;
  failedTasks?: string[];
  projectPlan?: ProjectPlan;
}

// ── Shell ────────────────────────────────────────────────────────────

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ── Planner ──────────────────────────────────────────────────────────

export interface PlanRequest {
  runId: string;
  plan: string;
  recipes?: string;
  preferences?: string;
}

export interface PlanResponse {
  runId: string;
  projectPlan: ProjectPlan;
}
