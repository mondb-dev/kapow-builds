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

export interface ProjectPlan {
  id: string;
  originalBrief: string;
  phases: Phase[];
  constraints: string[];
  architecture: ArchitectureDoc;
}

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

export interface GateResult {
  runId: string;
  ciSignal: 'go' | 'no-go' | 'escalate';
  iteration: number;
  delta?: string;
  diagnosis?: string;
  artifacts?: Artifact[];
}

// Board integration
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

export interface PipelineState {
  runId: string;
  plan: string;
  projectPlan?: ProjectPlan;
  currentPhase?: string;
  currentTask?: string;
  iteration: number;
  status: 'pending' | 'planning' | 'building' | 'qa' | 'gate' | 'done' | 'failed';
}
