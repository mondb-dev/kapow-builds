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
import { loadPipelineConfig, type PipelineStage } from './pipeline-config.js';
import { updateRunStatus, addRunArtifact, addRunLog } from 'kapow-db/runs';

// ── Config ───────────────────────────────────────────────────────────

const PLANNER_URL = process.env.PLANNER_URL ?? 'http://localhost:3001';
const TECHNICIAN_URL = process.env.TECHNICIAN_URL ?? 'http://localhost:3006';
const SECURITY_URL = process.env.SECURITY_URL ?? 'http://localhost:3007';

const board = new BoardClient();
const pipelineConfig = loadPipelineConfig();

// ── Helpers ──────────────────────────────────────────────────────────

async function notifySecurity(runId: string, service: string, action: string, data: Record<string, unknown>): Promise<void> {
  try {
    await axios.post(`${SECURITY_URL}/event`, { runId, service, action, data }, { timeout: 5_000 });
  } catch {
    // Non-blocking
  }
}

async function fetchReadyTools(): Promise<AvailableTool[]> {
  try {
    const res = await axios.get<AvailableTool[]>(`${TECHNICIAN_URL}/tools/ready`, { timeout: 10_000 });
    return res.data;
  } catch {
    return [];
  }
}

async function callStage(
  stage: PipelineStage,
  payload: Record<string, unknown>,
  runId: string,
): Promise<unknown> {
  if (stage.notifySecurity) {
    await notifySecurity(runId, stage.name, `${stage.role}_start`, payload);
  }

  const res = await axios.post(
    `${stage.url}${stage.path}`,
    payload,
    { timeout: stage.timeout },
  );

  if (stage.notifySecurity) {
    await notifySecurity(runId, stage.name, `${stage.role}_complete`, { success: true });
  }

  return res.data;
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
    onProgress(`[${runId}] ${readyTools.length} shared tools available.`);
  }

  await notifySecurity(runId, 'actions', 'pipeline_start', { plan: plan.slice(0, 500) });
  updateRunStatus(runId, 'planning').catch(() => {});

  // ── Step 1: Planner ─────────────────────────────────────────────
  onProgress(`[${runId}] Starting planner...`);
  let projectPlan: ProjectPlan;
  try {
    const planRes = await axios.post<ProjectPlan>(
      `${PLANNER_URL}/plan`,
      { runId, plan, recipes: recipesText || undefined, preferences: preferencesText || undefined },
      { timeout: 180_000 },
    );
    projectPlan = planRes.data;
    const totalTasks = projectPlan.phases.reduce((sum, p) => sum + p.tasks.length, 0);
    onProgress(`[${runId}] Planner complete. ${projectPlan.phases.length} phases, ${totalTasks} tasks.`);
  } catch (err) {
    onProgress(`[${runId}] Planner failed: ${errMsg(err)}`);
    return { success: false, diagnosis: `Planner failed: ${errMsg(err)}` };
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

  // ── Step 3: Execute phases using configured pipeline ────────────
  let sandboxPath: string | undefined;
  const completedTasks: string[] = [];
  const failedTasks: string[] = [];
  let allArtifacts: Artifact[] = [];

  const buildStage = pipelineConfig.taskStages.find((s) => s.role === 'build')!;
  const verifyStage = pipelineConfig.taskStages.find((s) => s.role === 'verify');
  const decideStage = pipelineConfig.taskStages.find((s) => s.role === 'decide');
  const fixStage = pipelineConfig.fixStage;

  for (const phase of topologicalSort(projectPlan.phases)) {
    onProgress(`[${runId}] Starting phase: ${phase.name}`);

    for (const task of topologicalSortTasks(phase.tasks)) {
      const cardId = cardIds.get(task.id) ?? '';

      // ── Build ─────────────────────────────────────────────
      await board.updateCardStatus(cardId, 'IN_PROGRESS');
      await board.addCardEvent(cardId, { message: `${buildStage.name} started`, type: 'PROGRESS' });
      onProgress(`[${runId}] Building task ${task.id}...`);
      updateRunStatus(runId, 'building').catch(() => {});

      let buildResult: TaskBuildResult;
      try {
        buildResult = await callStage(buildStage, {
          runId, task, phase,
          architecture: projectPlan.architecture,
          constraints: projectPlan.constraints,
          sandboxPath, completedTasks,
          availableTools: readyTools,
        }, runId) as TaskBuildResult;
        sandboxPath = buildResult.sandboxPath;
        onProgress(`[${runId}] Task ${task.id} built. ${buildResult.artifacts.length} artifacts.`);
      } catch (err) {
        await notifySecurity(runId, buildStage.name, 'build_error', { taskId: task.id, error: errMsg(err) });
        onProgress(`[${runId}] ${buildStage.name} failed on task ${task.id}: ${errMsg(err)}`);
        await board.updateCardStatus(cardId, 'FAILED');
        await board.addCardEvent(cardId, { message: `Build error: ${errMsg(err)}`, type: 'ERROR' });
        failedTasks.push(task.id);
        continue;
      }

      // ── Verify + Decide retry loop ────────────────────────
      let taskPassed = false;
      let iteration = 0;

      while (iteration < pipelineConfig.maxIterations) {
        iteration++;

        // Verify (QA)
        if (verifyStage) {
          await board.updateCardStatus(cardId, 'QA');
          await board.addCardEvent(cardId, { message: `${verifyStage.name} (iteration ${iteration})`, type: 'PROGRESS' });
          onProgress(`[${runId}] ${verifyStage.name} checking task ${task.id} (iteration ${iteration})...`);
          updateRunStatus(runId, 'qa').catch(() => {});

          let qaResult: TaskQAResult;
          try {
            qaResult = await callStage(verifyStage, {
              runId, task, phase,
              architecture: projectPlan.architecture,
              buildResult,
              availableTools: readyTools,
            }, runId) as TaskQAResult;
            onProgress(`[${runId}] ${verifyStage.name} task ${task.id}: passed=${qaResult.passed}, issues=${qaResult.issues.length}`);
          } catch (err) {
            onProgress(`[${runId}] ${verifyStage.name} failed on task ${task.id}: ${errMsg(err)}`);
            await board.addCardEvent(cardId, { message: `QA error: ${errMsg(err)}`, type: 'ERROR' });
            break;
          }

          // Decide (Gate)
          if (decideStage) {
            let gateResult: GateResult;
            try {
              gateResult = await callStage(decideStage, { runId, qaResult, iteration }, runId) as GateResult;
              onProgress(`[${runId}] ${decideStage.name} task ${task.id}: ${gateResult.ciSignal}`);
            } catch (err) {
              onProgress(`[${runId}] ${decideStage.name} failed on task ${task.id}: ${errMsg(err)}`);
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
              buildResult = await callStage(fixStage, {
                runId, task, phase,
                architecture: projectPlan.architecture,
                constraints: projectPlan.constraints,
                previousBuildResult: buildResult,
                delta: gateResult.delta,
                iteration,
              }, runId) as TaskBuildResult;
              onProgress(`[${runId}] Task ${task.id} fix complete.`);
            } catch (err) {
              onProgress(`[${runId}] Fix failed on task ${task.id}: ${errMsg(err)}`);
              await board.updateCardStatus(cardId, 'FAILED');
              await board.addCardEvent(cardId, { message: `Fix error: ${errMsg(err)}`, type: 'ERROR' });
              failedTasks.push(task.id);
              break;
            }
          } else {
            // No gate stage — QA pass = done
            taskPassed = qaResult.passed;
            if (taskPassed) {
              await board.updateCardStatus(cardId, 'DONE');
              await board.addCardEvent(cardId, { message: 'Task passed QA', type: 'SUCCESS' });
            }
            break;
          }
        } else {
          // No verify stage — build = done
          taskPassed = true;
          await board.updateCardStatus(cardId, 'DONE');
          await board.addCardEvent(cardId, { message: 'Task complete', type: 'SUCCESS' });
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
  await notifySecurity(runId, 'actions', 'pipeline_complete', {
    success: failedTasks.length === 0,
    failedCount: failedTasks.length,
    completedCount: completedTasks.length,
  });

  if (failedTasks.length === 0) {
    onProgress(`[${runId}] Pipeline complete. All tasks passed.`);
    updateRunStatus(runId, 'done', { completedTasks, failedTasks: [] }).catch(() => {});

    // Persist artifacts
    for (const artifact of allArtifacts) {
      addRunArtifact(runId, completedTasks[completedTasks.length - 1] ?? '', artifact.path, artifact.type, sandboxPath ?? '', undefined).catch(() => {});
    }

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
