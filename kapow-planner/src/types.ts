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

export interface PlanRequest {
  runId: string;
  plan: string;
}

export interface PlanResponse {
  runId: string;
  taskGraph: TaskGraph;
}
