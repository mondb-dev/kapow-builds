/**
 * Consolidated Orchestrator
 *
 * Calls planner, builder, QA, gate as direct functions — no HTTP.
 * The only network calls are to the technician (tool registry)
 * and the board (card management).
 */
import axios from 'axios';
import type {
  ProjectPlan, Phase, Task, Artifact,
  TaskBuildResult, TaskQAResult, GateResult,
  PipelineResult, AvailableTool,
} from 'kapow-shared';
import { BoardClient } from './board-client.js';
import {
  getProjectRecipes, getGlobalRecipes, formatRecipesForPrompt, upsertGlobalRecipe,
  type RecipeData,
} from 'kapow-db/recipes';
import {
  getProjectPreferences, getGlobalPreferences, formatPreferencesForPrompt,
} from 'kapow-db/preferences';
import { updateRunStatus, addRunArtifact, addRunLog } from 'kapow-db/runs';

// Direct function imports — no HTTP between agents
import { createProjectPlan } from './agents/planner.js';
import { buildTask, fixTask } from './agents/builder.js';
import { runTaskQA } from './agents/qa.js';
import { evaluate as gateEvaluate } from './agents/gate.js';

const TECHNICIAN_URL = process.env.TECHNICIAN_URL ?? 'http://localhost:3006';
const board = new BoardClient();

// ── Helpers ──────────────────────────────────────────────────────────

async function fetchReadyTools(): Promise<AvailableTool[]> {
  try {
    const res = await axios.get<AvailableTool[]>(`${TECHNICIAN_URL}/tools/ready`, { timeout: 10_000 });
    return res.data;
  } catch {
    return [];
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Pipeline ─────────────────────────────────────────────────────────

export async function runPipeline(
  runId: string,
  plan: string,
  onProgress: (msg: string) => void,
  projectId?: string,
): Promise<PipelineResult> {

  // ── Step 0: Load recipes, preferences, tools ────────────────────
  const recipes = projectId
    ? await getProjectRecipes(projectId)
    : await getGlobalRecipes();
  const preferences = projectId
    ? await getProjectPreferences(projectId)
    : await getGlobalPreferences();
  const recipesText = formatRecipesForPrompt(recipes);
  const preferencesText = formatPreferencesForPrompt(preferences);
  if (recipes.length > 0) onProgress(`[${runId}] Loaded ${recipes.length} recipes.`);
  if (Object.keys(preferences).length > 0) onProgress(`[${runId}] Loaded preferences.`);

  const readyTools = await fetchReadyTools();
  if (readyTools.length > 0) {
    onProgress(`[${runId}] ${readyTools.length} shared tools available from technician.`);
  }

  updateRunStatus(runId, 'planning').catch(() => {});

  // ── Step 1: Planner (direct function call) ──────────────────────
  onProgress(`[${runId}] Starting planner...`);
  let projectPlan: ProjectPlan;
  try {
    projectPlan = await createProjectPlan(runId, plan, recipesText || undefined, preferencesText || undefined);
    const totalTasks = projectPlan.phases.reduce((sum, p) => sum + p.tasks.length, 0);
    onProgress(`[${runId}] Planner complete. ${projectPlan.phases.length} phases, ${totalTasks} tasks.`);
  } catch (err) {
    const msg = errMsg(err);
    onProgress(`[${runId}] Planner failed: ${msg}`);
    updateRunStatus(runId, 'failed', { diagnosis: `Planner failed: ${msg}` }).catch(() => {});
    return { success: false, diagnosis: `Planner failed: ${msg}` };
  }

  // ── Step 2: Create board cards ──────────────────────────────────
  const cardIds = new Map<string, string>();
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

  // ── Step 3: Execute phases ──────────────────────────────────────
  let sandboxPath: string | undefined;
  const completedTasks: string[] = [];
  const failedTasks: string[] = [];
  let allArtifacts: Artifact[] = [];

  for (const phase of topologicalSort(projectPlan.phases)) {
    onProgress(`[${runId}] Starting phase: ${phase.name}`);

    for (const task of topologicalSortTasks(phase.tasks)) {
      const cardId = cardIds.get(task.id) ?? '';

      // ── Build (direct call) ───────────────────────────────
      await board.updateCardStatus(cardId, 'IN_PROGRESS');
      await board.addCardEvent(cardId, { message: 'Builder started', type: 'PROGRESS' });
      onProgress(`[${runId}] Building task ${task.id}...`);
      updateRunStatus(runId, 'building').catch(() => {});
      addRunLog(runId, 'pipeline', `Building task ${task.id}`, 'info').catch(() => {});

      let buildResult: TaskBuildResult;
      try {
        buildResult = await buildTask({
          runId, task, phase,
          architecture: projectPlan.architecture,
          constraints: projectPlan.constraints,
          sandboxPath,
          completedTasks,
          availableTools: readyTools,
        });
        sandboxPath = buildResult.sandboxPath;
        onProgress(`[${runId}] Task ${task.id} built. ${buildResult.artifacts.length} artifacts.`);
      } catch (err) {
        onProgress(`[${runId}] Builder failed on task ${task.id}: ${errMsg(err)}`);
        await board.updateCardStatus(cardId, 'FAILED');
        await board.addCardEvent(cardId, { message: `Build error: ${errMsg(err)}`, type: 'ERROR' });
        failedTasks.push(task.id);
        continue;
      }

      // ── QA + Gate retry loop (direct calls) ───────────────
      let taskPassed = false;
      let iteration = 0;
      const maxIterations = 3;

      while (iteration < maxIterations) {
        iteration++;

        // QA
        await board.updateCardStatus(cardId, 'QA');
        await board.addCardEvent(cardId, { message: `QA check (iteration ${iteration})`, type: 'PROGRESS' });
        onProgress(`[${runId}] QA checking task ${task.id} (iteration ${iteration})...`);
        updateRunStatus(runId, 'qa').catch(() => {});

        let qaResult: TaskQAResult;
        try {
          qaResult = await runTaskQA({
            runId, task, phase,
            architecture: projectPlan.architecture,
            buildResult,
            availableTools: readyTools,
          });
          onProgress(`[${runId}] QA task ${task.id}: passed=${qaResult.passed}, issues=${qaResult.issues.length}`);
        } catch (err) {
          onProgress(`[${runId}] QA failed on task ${task.id}: ${errMsg(err)}`);
          await board.addCardEvent(cardId, { message: `QA error: ${errMsg(err)}`, type: 'ERROR' });
          break;
        }

        // Gate
        let gateResult: GateResult;
        try {
          gateResult = await gateEvaluate(runId, qaResult, iteration);
          onProgress(`[${runId}] Gate task ${task.id}: ${gateResult.ciSignal}`);
        } catch (err) {
          onProgress(`[${runId}] Gate failed on task ${task.id}: ${errMsg(err)}`);
          await board.addCardEvent(cardId, { message: `Gate error: ${errMsg(err)}`, type: 'ERROR' });
          break;
        }

        if (gateResult.ciSignal === 'go') {
          taskPassed = true;
          await board.updateCardStatus(cardId, 'DONE');
          await board.addCardEvent(cardId, { message: 'Task passed', type: 'SUCCESS' });
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

        // no-go → fix
        await board.updateCardStatus(cardId, 'IN_PROGRESS');
        await board.addCardEvent(cardId, {
          message: `Fix needed (iteration ${iteration}): ${gateResult.delta?.slice(0, 300) ?? ''}`,
          type: 'PROGRESS',
        });
        onProgress(`[${runId}] Fixing task ${task.id} (iteration ${iteration})...`);

        try {
          buildResult = await fixTask({
            runId, task, phase,
            architecture: projectPlan.architecture,
            constraints: projectPlan.constraints,
            previousBuildResult: buildResult,
            delta: gateResult.delta ?? '',
            iteration,
          });
          onProgress(`[${runId}] Task ${task.id} fix complete.`);
        } catch (err) {
          onProgress(`[${runId}] Fix failed on task ${task.id}: ${errMsg(err)}`);
          await board.updateCardStatus(cardId, 'FAILED');
          await board.addCardEvent(cardId, { message: `Fix error: ${errMsg(err)}`, type: 'ERROR' });
          failedTasks.push(task.id);
          break;
        }
      }

      if (taskPassed) {
        completedTasks.push(task.id);
        allArtifacts = buildResult.artifacts;
        // Persist artifacts
        for (const artifact of buildResult.artifacts) {
          addRunArtifact(runId, task.id, artifact.path, artifact.type, sandboxPath ?? '', undefined).catch(() => {});
        }
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
    updateRunStatus(runId, 'done', { completedTasks, failedTasks: [] }).catch(() => {});

    try {
      const newRecipes = extractRecipes(projectPlan, runId);
      for (const recipe of newRecipes) {
        await upsertGlobalRecipe(recipe);
      }
      if (newRecipes.length > 0) {
        onProgress(`[${runId}] Saved ${newRecipes.length} recipe(s) from successful run.`);
      }
    } catch (err) {
      onProgress(`[${runId}] Recipe save failed (non-fatal): ${errMsg(err)}`);
    }

    return { success: true, artifacts: allArtifacts, projectPlan };
  }

  onProgress(`[${runId}] Pipeline finished with ${failedTasks.length} failed tasks: ${failedTasks.join(', ')}`);
  updateRunStatus(runId, 'failed', { completedTasks, failedTasks }).catch(() => {});
  return {
    success: false,
    artifacts: allArtifacts,
    failedTasks,
    projectPlan,
    diagnosis: `${failedTasks.length} tasks failed: ${failedTasks.join(', ')}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractRecipes(projectPlan: ProjectPlan, runId: string): RecipeData[] {
  const arch = projectPlan.architecture;
  if (!arch?.techStack) return [];

  const overview = (arch.overview ?? '').toLowerCase();
  let category = 'general';
  if (overview.includes('website') || overview.includes('landing') || overview.includes('next')) category = 'web';
  else if (overview.includes('api') || overview.includes('server') || overview.includes('backend')) category = 'api';
  else if (overview.includes('cli') || overview.includes('command')) category = 'cli';
  else if (overview.includes('mobile') || overview.includes('app')) category = 'mobile';

  const stackWords = arch.techStack.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 3);
  const id = `learned-${category}-${stackWords.join('-')}`;

  return [{
    id,
    name: `${category} project (${stackWords.join(', ')})`,
    category,
    tags: stackWords.filter((w) => w.length > 2),
    content: [
      `Tech Stack: ${arch.techStack}`,
      `File Structure: ${arch.fileStructure}`,
      `Conventions: ${arch.conventions}`,
      arch.notes ? `Notes: ${arch.notes}` : '',
    ].filter(Boolean).join('\n'),
    source: runId,
  }];
}

function topologicalSort(phases: Phase[]): Phase[] {
  const map = new Map(phases.map((p) => [p.id, p]));
  const visited = new Set<string>();
  const result: Phase[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const p = map.get(id);
    if (!p) return;
    for (const dep of p.dependencies) visit(dep);
    result.push(p);
  }
  for (const p of phases) visit(p.id);
  return result;
}

function topologicalSortTasks(tasks: Task[]): Task[] {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const result: Task[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const t = map.get(id);
    if (!t) return;
    for (const dep of t.dependencies) visit(dep);
    result.push(t);
  }
  for (const t of tasks) visit(t.id);
  return result;
}
