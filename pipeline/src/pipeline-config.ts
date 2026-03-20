/**
 * Pipeline Stage Configuration
 *
 * Defines the agent stages that a task passes through.
 * The orchestrator reads this instead of hardcoding Build→QA→Gate.
 *
 * To add a new stage (e.g. "security-review"):
 * 1. Add a PipelineStage entry here
 * 2. Deploy the new agent service
 * 3. Restart orchestrator — no code changes needed
 */

export interface PipelineStage {
  /** Unique stage name (used in logs and events) */
  name: string;

  /** HTTP endpoint to call (POST) */
  url: string;

  /** What this stage does (for logging) */
  role: 'build' | 'verify' | 'decide' | 'fix';

  /** Request timeout in ms */
  timeout: number;

  /** HTTP path on the service */
  path: string;

  /** Should security be notified on start/complete? */
  notifySecurity: boolean;
}

export interface PipelineConfig {
  /** Stages executed per task, in order */
  taskStages: PipelineStage[];

  /** Fix stage (called on gate no-go) */
  fixStage: PipelineStage;

  /** Max retry iterations per task */
  maxIterations: number;
}

/**
 * Load pipeline configuration from environment.
 * Defaults to the standard Build→QA→Gate flow.
 */
export function loadPipelineConfig(): PipelineConfig {
  const builderUrl = process.env.BUILDER_URL ?? 'http://localhost:3002';
  const qaUrl = process.env.QA_URL ?? 'http://localhost:3003';
  const gateUrl = process.env.GATE_URL ?? 'http://localhost:3004';

  // Default pipeline: Build → QA → Gate
  // Override by setting PIPELINE_STAGES as JSON in .env
  const customStages = process.env.PIPELINE_STAGES;
  if (customStages) {
    try {
      const parsed = JSON.parse(customStages) as PipelineConfig;
      console.log(`[pipeline] Loaded custom pipeline config: ${parsed.taskStages.map((s) => s.name).join(' → ')}`);
      return parsed;
    } catch (err) {
      console.warn(`[pipeline] Invalid PIPELINE_STAGES JSON, using defaults`);
    }
  }

  return {
    taskStages: [
      {
        name: 'builder',
        url: builderUrl,
        role: 'build',
        timeout: 600_000,
        path: '/build-task',
        notifySecurity: true,
      },
      {
        name: 'qa',
        url: qaUrl,
        role: 'verify',
        timeout: 300_000,
        path: '/qa-task',
        notifySecurity: false,
      },
      {
        name: 'gate',
        url: gateUrl,
        role: 'decide',
        timeout: 60_000,
        path: '/gate',
        notifySecurity: true,
      },
    ],
    fixStage: {
      name: 'builder',
      url: builderUrl,
      role: 'fix',
      timeout: 600_000,
      path: '/fix-task',
      notifySecurity: true,
    },
    maxIterations: 3,
  };
}
