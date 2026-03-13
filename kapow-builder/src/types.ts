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

export interface BuildRequest {
  runId: string;
  taskGraph: TaskGraph;
}

export interface FixRequest {
  runId: string;
  taskGraph: TaskGraph;
  previousBuildResult: BuildResult;
  delta: string;
  iteration: number;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
