import axios from 'axios';
import {
  ProjectPlan, Phase, Task,
  TaskBuildResult, TaskQAResult, GateResult, Artifact,
} from './types.js';
import { BoardClient } from './board-client.js';

const PLANNER_URL = process.env.PLANNER_URL ?? 'http://localhost:3001';
const BUILDER_URL = process.env.BUILDER_URL ?? 'http://localhost:3002';
const QA_URL = process.env.QA_URL ?? 'http://localhost:3003';
const GATE_URL = process.env.GATE_URL ?? 'http://localhost:3004';

const board = new BoardClient();

export interface PipelineResult {
  success: boolean;
  artifacts?: Artifact[];
  diagnosis?: string;
  failedTasks?: string[];
  projectPlan?: ProjectPlan;
}

export async function runPipeline(
  runId: string,
  plan: string,
  onProgress: (msg: string) => void
): Promise<PipelineResult> {

  // ── Step 1: Planner ─────────────────────────────────────────────
  onProgress(`[${runId}] Starting planner...`);
  let projectPlan: ProjectPlan;
  try {
    const planRes = await axios.post<ProjectPlan>(
      `${PLANNER_URL}/plan`,
      { runId, plan },
      { timeout: 180_000 }
    );
    projectPlan = planRes.data;
    const totalTasks = projectPlan.phases.reduce((sum, p) => sum + p.tasks.length, 0);
    onProgress(`[${runId}] Planner complete. ${projectPlan.phases.length} phases, ${totalTasks} tasks.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress(`[${runId}] Planner failed: ${msg}`);
    return { success: false, diagnosis: `Planner failed: ${msg}` };
  }

  // ── Step 2: Create cards on board for all tasks ─────────────────
  const cardIds = new Map<string, string>(); // taskId → cardId
  for (const phase of projectPlan.phases) {
    for (const task of phase.tasks) {
      const card = await board.createCard({
        title: `[${phase.name}] ${task.description.slice(0, 150)}`,
        description: task.description,
        status: 'BACKLOG',
        runId,
        phaseId: phase.id,
        taskId: task.id,
      });
      cardIds.set(task.id, card.id);
    }
  }
  onProgress(`[${runId}] Board cards created.`);

  // ── Step 3: Execute phases in order ─────────────────────────────
  let sandboxPath: string | undefined;
  const completedTasks: string[] = [];
  const failedTasks: string[] = [];
  let allArtifacts: Artifact[] = [];

  const sortedPhases = topologicalSort(projectPlan.phases);

  for (const phase of sortedPhases) {
    onProgress(`[${runId}] Starting phase: ${phase.name}`);

    const sortedTasks = topologicalSortTasks(phase.tasks);

    for (const task of sortedTasks) {
      const cardId = cardIds.get(task.id) ?? '';

      // ── Build task ──────────────────────────────────────────
      await board.updateCardStatus(cardId, 'IN_PROGRESS');
      await board.addCardEvent(cardId, { message: 'Builder started', type: 'PROGRESS' });
      onProgress(`[${runId}] Building task ${task.id}...`);

      let buildResult: TaskBuildResult;
      try {
        const buildRes = await axios.post<TaskBuildResult>(
          `${BUILDER_URL}/build-task`,
          {
            runId,
            task,
            phase,
            architecture: projectPlan.architecture,
            constraints: projectPlan.constraints,
            sandboxPath,
            completedTasks,
          },
          { timeout: 600_000 }
        );
        buildResult = buildRes.data;
        sandboxPath = buildResult.sandboxPath;
        onProgress(`[${runId}] Task ${task.id} built. ${buildResult.artifacts.length} artifacts.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        onProgress(`[${runId}] Builder failed on task ${task.id}: ${msg}`);
        await board.updateCardStatus(cardId, 'FAILED');
        await board.addCardEvent(cardId, { message: `Builder error: ${msg}`, type: 'ERROR' });
        failedTasks.push(task.id);
        continue;
      }

      // ── QA/Gate retry loop per task ─────────────────────────
      let taskPassed = false;
      let iteration = 0;

      while (iteration < 3) {
        iteration++;

        // QA
        await board.updateCardStatus(cardId, 'QA');
        await board.addCardEvent(cardId, { message: `QA check (iteration ${iteration})`, type: 'PROGRESS' });
        onProgress(`[${runId}] QA checking task ${task.id} (iteration ${iteration})...`);

        let qaResult: TaskQAResult;
        try {
          const qaRes = await axios.post<TaskQAResult>(
            `${QA_URL}/qa-task`,
            {
              runId,
              task,
              phase,
              architecture: projectPlan.architecture,
              buildResult,
            },
            { timeout: 300_000 }
          );
          qaResult = qaRes.data;
          onProgress(`[${runId}] QA task ${task.id}: passed=${qaResult.passed}, issues=${qaResult.issues.length}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          onProgress(`[${runId}] QA failed on task ${task.id}: ${msg}`);
          await board.addCardEvent(cardId, { message: `QA error: ${msg}`, type: 'ERROR' });
          break;
        }

        // Gate
        let gateResult: GateResult;
        try {
          const gateRes = await axios.post<GateResult>(
            `${GATE_URL}/gate`,
            { runId, qaResult, iteration },
            { timeout: 60_000 }
          );
          gateResult = gateRes.data;
          onProgress(`[${runId}] Gate task ${task.id}: ${gateResult.ciSignal}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          onProgress(`[${runId}] Gate failed on task ${task.id}: ${msg}`);
          await board.addCardEvent(cardId, { message: `Gate error: ${msg}`, type: 'ERROR' });
          break;
        }

        if (gateResult.ciSignal === 'go') {
          taskPassed = true;
          await board.updateCardStatus(cardId, 'DONE');
          await board.addCardEvent(cardId, { message: 'Task passed QA', type: 'SUCCESS' });
          break;
        }

        if (gateResult.ciSignal === 'escalate') {
          await board.updateCardStatus(cardId, 'FAILED');
          await board.addCardEvent(cardId, {
            message: `Escalated: ${gateResult.diagnosis?.slice(0, 500) ?? 'max iterations'}`,
            type: 'ERROR',
          });
          failedTasks.push(task.id);
          break;
        }

        // no-go: fix and retry
        await board.updateCardStatus(cardId, 'IN_PROGRESS');
        await board.addCardEvent(cardId, {
          message: `Fix needed (iteration ${iteration}): ${gateResult.delta?.slice(0, 300) ?? ''}`,
          type: 'PROGRESS',
        });
        onProgress(`[${runId}] Fixing task ${task.id} (iteration ${iteration})...`);

        try {
          const fixRes = await axios.post<TaskBuildResult>(
            `${BUILDER_URL}/fix-task`,
            {
              runId,
              task,
              phase,
              architecture: projectPlan.architecture,
              constraints: projectPlan.constraints,
              previousBuildResult: buildResult,
              delta: gateResult.delta,
              iteration,
            },
            { timeout: 600_000 }
          );
          buildResult = fixRes.data;
          onProgress(`[${runId}] Task ${task.id} fix complete.`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          onProgress(`[${runId}] Builder fix failed on task ${task.id}: ${msg}`);
          await board.updateCardStatus(cardId, 'FAILED');
          await board.addCardEvent(cardId, { message: `Fix error: ${msg}`, type: 'ERROR' });
          failedTasks.push(task.id);
          break;
        }
      }

      if (taskPassed) {
        completedTasks.push(task.id);
        allArtifacts = buildResult.artifacts;
      } else if (!failedTasks.includes(task.id)) {
        await board.updateCardStatus(cardId, 'FAILED');
        await board.addCardEvent(cardId, { message: 'Max iterations reached', type: 'ERROR' });
        failedTasks.push(task.id);
      }
    }
  }

  // ── Result ──────────────────────────────────────────────────────
  if (failedTasks.length === 0) {
    onProgress(`[${runId}] Pipeline complete. All tasks passed.`);
    return { success: true, artifacts: allArtifacts, projectPlan };
  }

  onProgress(`[${runId}] Pipeline finished with ${failedTasks.length} failed tasks: ${failedTasks.join(', ')}`);
  return {
    success: false,
    artifacts: allArtifacts,
    failedTasks,
    projectPlan,
    diagnosis: `${failedTasks.length} tasks failed: ${failedTasks.join(', ')}`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function topologicalSort(phases: Phase[]): Phase[] {
  const phaseMap = new Map(phases.map((p) => [p.id, p]));
  const visited = new Set<string>();
  const result: Phase[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const phase = phaseMap.get(id);
    if (!phase) return;
    for (const dep of phase.dependencies) {
      visit(dep);
    }
    result.push(phase);
  }

  for (const phase of phases) {
    visit(phase.id);
  }
  return result;
}

function topologicalSortTasks(tasks: Task[]): Task[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const result: Task[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const task = taskMap.get(id);
    if (!task) return;
    for (const dep of task.dependencies) {
      visit(dep);
    }
    result.push(task);
  }

  for (const task of tasks) {
    visit(task.id);
  }
  return result;
}
