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
  path: string;
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
  delta: string;
}

export interface QARequest {
  runId: string;
  taskGraph: TaskGraph;
  buildResult: BuildResult;
}
