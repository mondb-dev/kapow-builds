// Re-export shared types — single source of truth is kapow-shared
export type {
  Task, Phase, ArchitectureDoc, Artifact,
  TaskBuildResult, TaskQAResult, Issue, GateResult,
} from 'kapow-shared';

// Gate-local types (not shared across services)
import type { TaskQAResult, Artifact } from 'kapow-shared';

export interface GateRequest {
  runId: string;
  qaResult: TaskQAResult;
  iteration: number;
  artifacts?: Artifact[];
}

export const MAX_ITERATIONS = 3;
