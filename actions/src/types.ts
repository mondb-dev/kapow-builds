// Re-export shared types — single source of truth is kapow-shared
export type {
  Task, Phase, ArchitectureDoc, ProjectPlan,
  Artifact, TaskBuildResult, TaskQAResult, GateResult,
  Issue, BoardCard, BoardEvent, PipelineState,
  PipelineResult, AvailableTool,
} from 'kapow-shared';
