export interface Task {
  id: string;
  description: string;
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

export interface ArchitectureDoc {
  overview: string;
  techStack: string;
  fileStructure: string;
  conventions: string;
  resolvedAmbiguities: string[];
  notes: string;
}

export interface Artifact {
  path: string;
  type: 'file' | 'directory';
  content?: string;
}

export interface TaskBuildRequest {
  runId: string;
  task: Task;
  phase: Phase;
  architecture: ArchitectureDoc;
  constraints: string[];
  sandboxPath?: string;
  completedTasks: string[];
}

export interface TaskBuildResult {
  runId: string;
  taskId: string;
  sandboxPath: string;
  artifacts: Artifact[];
  logs: string[];
  success: boolean;
}

export interface TaskFixRequest {
  runId: string;
  task: Task;
  phase: Phase;
  architecture: ArchitectureDoc;
  constraints: string[];
  previousBuildResult: TaskBuildResult;
  delta: string;
  iteration: number;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
