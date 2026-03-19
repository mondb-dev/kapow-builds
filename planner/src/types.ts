export interface Task {
  id: string;
  description: string;
  type: 'code' | 'shell' | 'browser' | 'file' | 'api';
  dependencies: string[]; // task IDs within same phase
  acceptanceCriteria: string[];
}

export interface Phase {
  id: string;
  name: string;
  description: string;
  tasks: Task[];
  dependencies: string[]; // phase IDs that must complete first
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

export interface PlanRequest {
  runId: string;
  plan: string;
  recipes?: string;     // formatted recipe text to inject into planning context
  preferences?: string; // formatted preference text to inject into planning context
}

export interface PlanResponse {
  runId: string;
  projectPlan: ProjectPlan;
}
