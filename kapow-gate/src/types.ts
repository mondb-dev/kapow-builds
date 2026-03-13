export interface Artifact {
  path: string;
  type: 'file' | 'directory';
  content?: string;
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

export interface GateResult {
  runId: string;
  ciSignal: 'go' | 'no-go' | 'escalate';
  iteration: number;
  delta?: string;
  diagnosis?: string;
  artifacts?: Artifact[];
}

export interface GateRequest {
  runId: string;
  qaResult: QAResult;
  iteration: number;
  artifacts?: Artifact[];
}

export const MAX_ITERATIONS = 3;
