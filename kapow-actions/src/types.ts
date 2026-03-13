export interface Task {
  id: string;
  description: string;
  type: 'code' | 'shell' | 'browser' | 'file' | 'api';
  dependencies: string[];
  acceptanceCriteria: string[];
}

export interface TaskGraph {
  id: string;
  originalPlan: string;
  tasks: Task[];
  constraints: string[];
  context: Record<string, unknown>;
}

export interface Artifact {
  path: string; // relative to sandbox
  type: 'file' | 'directory';
  content?: string;
}

export interface BuildResult {
  runId: string;
  taskGraphId: string;
  sandboxPath: string;
  artifacts: Artifact[];
  logs: string[];
  success: boolean;
}

export interface Issue {
  severity: 'critical' | 'major' | 'minor';
  taskId: string;
  description: string;
  file?: string;
}

export interface QAResult {
  runId: string;
  passed: boolean;
  issues: Issue[];
  delta: string; // targeted description of what's wrong/missing
}

export interface GateResult {
  runId: string;
  ciSignal: 'go' | 'no-go' | 'escalate';
  iteration: number;
  delta?: string; // for builder on retry
  diagnosis?: string; // for user on escalate
  artifacts?: Artifact[];
}

export interface PlanRequest {
  runId: string;
  plan: string;
}

export interface PipelineState {
  runId: string;
  plan: string;
  taskGraph?: TaskGraph;
  buildResult?: BuildResult;
  qaResult?: QAResult;
  gateResult?: GateResult;
  iteration: number;
  status: 'pending' | 'planning' | 'building' | 'qa' | 'gate' | 'done' | 'failed';
}
