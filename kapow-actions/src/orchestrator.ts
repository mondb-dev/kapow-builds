import axios from 'axios';
import { TaskGraph, BuildResult, QAResult, GateResult, Artifact } from './types.js';

const PLANNER_URL = process.env.PLANNER_URL ?? 'http://localhost:3001';
const BUILDER_URL = process.env.BUILDER_URL ?? 'http://localhost:3002';
const QA_URL = process.env.QA_URL ?? 'http://localhost:3003';
const GATE_URL = process.env.GATE_URL ?? 'http://localhost:3004';

export async function runPipeline(
  runId: string,
  plan: string,
  onProgress: (msg: string) => void
): Promise<{ success: boolean; artifacts?: Artifact[]; diagnosis?: string }> {
  let iteration = 0;
  let currentBuildResult: BuildResult | undefined;

  // Step 1: Plan validation
  onProgress(`[${runId}] Starting planner...`);
  let taskGraph: TaskGraph;
  try {
    const planRes = await axios.post<TaskGraph>(`${PLANNER_URL}/plan`, { runId, plan }, { timeout: 120_000 });
    taskGraph = planRes.data;
    onProgress(`[${runId}] Planner complete. ${taskGraph.tasks.length} tasks identified.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress(`[${runId}] Planner failed: ${msg}`);
    return { success: false, diagnosis: `Planner failed: ${msg}` };
  }

  // Step 2: Initial build
  onProgress(`[${runId}] Starting builder (iteration ${iteration + 1})...`);
  try {
    const buildRes = await axios.post<BuildResult>(
      `${BUILDER_URL}/build`,
      { runId, taskGraph },
      { timeout: 600_000 }
    );
    currentBuildResult = buildRes.data;
    onProgress(`[${runId}] Builder complete. ${currentBuildResult.artifacts.length} artifacts produced.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress(`[${runId}] Builder failed: ${msg}`);
    return { success: false, diagnosis: `Builder failed: ${msg}` };
  }

  // Retry loop: QA → Gate → (fix → QA → Gate) up to 3 iterations
  while (iteration < 3) {
    iteration += 1;

    // Step 3: QA
    onProgress(`[${runId}] Starting QA (iteration ${iteration})...`);
    let qaResult: QAResult;
    try {
      const qaRes = await axios.post<QAResult>(
        `${QA_URL}/qa`,
        { runId, taskGraph, buildResult: currentBuildResult },
        { timeout: 300_000 }
      );
      qaResult = qaRes.data;
      onProgress(
        `[${runId}] QA complete. Passed: ${qaResult.passed}. Issues: ${qaResult.issues.length}`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress(`[${runId}] QA failed: ${msg}`);
      return { success: false, diagnosis: `QA failed: ${msg}` };
    }

    // Step 4: Gate
    onProgress(`[${runId}] Running gate check (iteration ${iteration})...`);
    let gateResult: GateResult;
    try {
      const gateRes = await axios.post<GateResult>(
        `${GATE_URL}/gate`,
        { runId, qaResult, iteration },
        { timeout: 60_000 }
      );
      gateResult = gateRes.data;
      onProgress(`[${runId}] Gate signal: ${gateResult.ciSignal}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress(`[${runId}] Gate failed: ${msg}`);
      return { success: false, diagnosis: `Gate failed: ${msg}` };
    }

    if (gateResult.ciSignal === 'go') {
      onProgress(`[${runId}] Pipeline complete. Artifacts ready.`);
      return { success: true, artifacts: gateResult.artifacts ?? currentBuildResult?.artifacts ?? [] };
    }

    if (gateResult.ciSignal === 'escalate') {
      onProgress(`[${runId}] Escalating after ${iteration} iterations.`);
      return { success: false, diagnosis: gateResult.diagnosis };
    }

    // no-go: send delta to builder for targeted fix
    onProgress(`[${runId}] Gate no-go. Sending delta to builder for fix (iteration ${iteration})...`);
    try {
      const fixRes: { data: BuildResult } = await axios.post<BuildResult>(
        `${BUILDER_URL}/fix`,
        {
          runId,
          taskGraph,
          previousBuildResult: currentBuildResult,
          delta: gateResult.delta,
          iteration,
        },
        { timeout: 600_000 }
      );
      currentBuildResult = fixRes.data;
      onProgress(`[${runId}] Builder fix complete. ${currentBuildResult!.artifacts.length} artifacts.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress(`[${runId}] Builder fix failed: ${msg}`);
      return { success: false, diagnosis: `Builder fix failed: ${msg}` };
    }
  }

  return { success: false, diagnosis: 'Maximum iterations reached without passing gate.' };
}
