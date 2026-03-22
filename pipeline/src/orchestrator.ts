/**
 * Consolidated Orchestrator
 *
 * Calls planner, builder, QA, gate as direct functions — no HTTP.
 * The only network calls are to the technician (tool registry)
 * and the board (card management).
 */
import axios from 'axios';
import type {
  ProjectPlan, Phase, Task, Artifact, ArchitectureDoc,
  TaskBuildResult, TaskQAResult, GateResult,
  PipelineResult, AvailableTool,
} from 'kapow-shared';
import { BoardClient, type CardOutput } from './board-client.js';
import {
  getProjectRecipes, findRelevantRecipes, formatRecipesForPrompt, upsertGlobalRecipe,
  type RecipeData,
} from 'kapow-db/recipes';
import {
  getProjectPreferences, getGlobalPreferences, formatPreferencesForPrompt,
} from 'kapow-db/preferences';
import { updateRunStatus, addRunArtifact, addRunLog, getRun } from 'kapow-db/runs';

// Direct function imports — no HTTP between agents
import { createProjectPlan } from './agents/planner.js';
import { buildTask, fixTask } from './agents/builder.js';
import { runTaskQA } from './agents/qa.js';
import { evaluate as gateEvaluate } from './agents/gate.js';
import { assertRunActive, RunStoppedError } from './run-control.js';

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

function buildCardOutput(artifacts: Artifact[], _task?: Task, runId?: string): CardOutput {
  // Filter to only project files — exclude system/cache paths
  const projectFiles = artifacts.filter((a) =>
    a.type === 'file' &&
    !a.path.includes('node_modules') &&
    !a.path.includes('.git/') &&
    !a.path.includes('Library/') &&
    !a.path.includes('.cache') &&
    !a.path.includes('__pycache__') &&
    !a.path.startsWith('.')
  );

  if (projectFiles.length === 0) {
    return { type: 'summary', summary: `Task completed. ${artifacts.length > 0 ? artifacts.length + ' internal files generated.' : 'No file output.'}`, runId };
  }

  const hasProject = projectFiles.some((f) =>
    f.path.includes('package.json') || f.path.includes('server') ||
    f.path.endsWith('.html') || f.path.endsWith('.tsx') || f.path.endsWith('.jsx')
  );

  // For projects, show summary + key files
  if (hasProject && projectFiles.length > 5) {
    return {
      type: 'summary',
      summary: `Built ${projectFiles.length} files.`,
      files: projectFiles.slice(0, 10).map((f) => ({ name: f.path.split('/').pop() ?? f.path, path: f.path })),
      runId,
    };
  }

  // For direct outputs, list all files
  return {
    type: 'files',
    files: projectFiles.slice(0, 10).map((f) => ({ name: f.path.split('/').pop() ?? f.path, path: f.path })),
    summary: `${projectFiles.length} file${projectFiles.length === 1 ? '' : 's'} produced.`,
    runId,
  };
}

// ── Pipeline ─────────────────────────────────────────────────────────

export async function runPipeline(
  runId: string,
  plan: string,
  onProgress: (msg: string) => void,
  projectId?: string,
): Promise<PipelineResult> {
  try {

  // ── Step 0: Load recipes, preferences, tools ────────────────────
  const recipes = projectId
    ? await getProjectRecipes(projectId)
    : await findRelevantRecipes(plan);
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

  // ── Step 1+2: Reuse existing cards OR plan + create new ones ──
  const cardIds = new Map<string, string>();
  const existingCards = await board.listCards(runId);
  const plannedCards = existingCards.filter((c) => c.taskId);
  let projectPlan: ProjectPlan;

  if (plannedCards.length > 0) {
    // Cards already exist from the plan route — try to use stored planData first
    onProgress(`[${runId}] Found ${plannedCards.length} pre-planned cards. Skipping planner.`);

    // Check if Run has stored planner output
    const runRecord = await getRun(runId);
    const storedPlan = runRecord?.planData as { phases?: Phase[]; constraints?: string[]; architecture?: ArchitectureDoc } | null;

    if (storedPlan?.phases?.length) {
      // Full planner output available — use it directly
      onProgress(`[${runId}] Using stored planner output (${storedPlan.phases.length} phases).`);
      projectPlan = {
        id: runId,
        originalBrief: plan,
        phases: storedPlan.phases,
        constraints: storedPlan.constraints ?? [],
        architecture: storedPlan.architecture ?? {
          overview: plan,
          techStack: 'Determined by task requirements',
          fileStructure: 'As specified in tasks',
          conventions: 'Follow standard conventions for the chosen stack',
          resolvedAmbiguities: [],
          notes: '',
        },
      };
      // Map existing cards by taskId
      for (const card of plannedCards) {
        if (card.taskId) cardIds.set(card.taskId, card.id);
      }
    } else {
      // No stored plan — reconstruct from card metadata
      const phaseMap = new Map<string, { id: string; name: string; tasks: Task[] }>();
    for (const card of plannedCards) {
      const phaseId = card.phaseId ?? 'phase_1';
      if (!phaseMap.has(phaseId)) {
        // Extract phase name from card title pattern "[Phase Name] task..."
        const phaseNameMatch = card.title.match(/^\[([^\]]+)\]/);
        const phaseName = phaseNameMatch?.[1] ?? phaseId.replace(/_/g, ' ');
        phaseMap.set(phaseId, { id: phaseId, name: phaseName, tasks: [] });
      }
      const phase = phaseMap.get(phaseId)!;

      // Parse acceptance criteria from card description
      const desc = card.description ?? card.title;
      const acLines: string[] = [];
      let inAC = false;
      for (const line of desc.split('\n')) {
        if (line.includes('Acceptance Criteria')) { inAC = true; continue; }
        if (inAC && line.trim().startsWith('-')) {
          acLines.push(line.trim().replace(/^-\s*/, ''));
        } else if (inAC && !line.trim()) {
          // blank line after AC section
        } else if (inAC && line.trim()) {
          inAC = false;
        }
      }

      phase.tasks.push({
        id: card.taskId!,
        description: desc,
        type: 'code',
        dependencies: [],
        acceptanceCriteria: acLines,
      });
      cardIds.set(card.taskId!, card.id);
    }

    projectPlan = {
      id: runId,
      originalBrief: plan,
      phases: Array.from(phaseMap.values()).map((p) => ({
        ...p,
        description: p.name,
        dependencies: [],
      })),
      constraints: [],
      // Generate a minimal architecture doc from the brief
      architecture: {
        overview: plan,
        techStack: 'Determined by task requirements',
        fileStructure: 'As specified in tasks',
        conventions: 'Follow standard conventions for the chosen stack',
        resolvedAmbiguities: [],
        notes: '',
      },
    };
    }
  } else {
    // No pre-planned cards — run the planner fresh
    onProgress(`[${runId}] Starting planner...`);
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

    // Create board cards
    for (const phase of projectPlan.phases) {
      for (const task of phase.tasks) {
        const card = await board.createCard({
          title: `[${phase.name}] ${task.description.slice(0, 150)}`,
          description: task.description,
          status: 'BACKLOG',
          runId,
          phaseId: phase.id,
          taskId: task.id,
          projectId,
        });
        cardIds.set(task.id, card.id);
      }
    }
    onProgress(`[${runId}] Board cards created.`);
  }

  // ── Step 3: Execute phases ──────────────────────────────────────
  let sandboxPath: string | undefined;
  const completedTasks: string[] = [];
  const failedTasks: string[] = [];
  let allArtifacts: Artifact[] = [];
  const allBuildLogs: string[] = [];

  for (const phase of topologicalSort(projectPlan.phases)) {
    assertRunActive(runId);
    onProgress(`[${runId}] Starting phase: ${phase.name}`);

    for (const task of topologicalSortTasks(phase.tasks)) {
      assertRunActive(runId);
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
        allBuildLogs.push(...buildResult.logs);
        onProgress(`[${runId}] Task ${task.id} built. ${buildResult.artifacts.length} artifacts.`);
      } catch (err) {
        onProgress(`[${runId}] Builder failed on task ${task.id}: ${errMsg(err)}`);
        await board.updateCard(cardId, { status: 'FAILED', output: { type: 'summary', summary: `Build failed: ${errMsg(err)}` } });
        await board.addCardEvent(cardId, { message: `Build error: ${errMsg(err)}`, type: 'ERROR' });
        failedTasks.push(task.id);
        continue;
      }

      // ── Skip QA for simple file/content tasks ─────────────
      const isSimpleTask = task.type === 'file' || task.type === 'shell';

      if (isSimpleTask && buildResult.success) {
        // For file/shell tasks, verify output exists and skip QA
        const output = buildCardOutput(buildResult.artifacts, task, runId);
        const hasOutput = output.files && output.files.length > 0;
        if (hasOutput) {
          onProgress(`[${runId}] Simple task ${task.id} — skipping QA.`);
          await board.updateCard(cardId, { status: 'DONE', output });
          await board.addCardEvent(cardId, { message: output.summary ?? 'Task completed', type: 'SUCCESS' });
          completedTasks.push(task.id);
          allArtifacts.push(...buildResult.artifacts);
          for (const artifact of buildResult.artifacts) {
            addRunArtifact(runId, task.id, artifact.path, artifact.type, sandboxPath ?? '', undefined).catch(() => {});
          }
          continue;
        }
        // No output files — fall through to QA
      }

      // ── QA + Gate retry loop (direct calls) ───────────────
      let taskPassed = false;
      let iteration = 0;
      const maxIterations = 3;
      const previousQAResults: TaskQAResult[] = [];

      while (iteration < maxIterations) {
        iteration++;

        // QA
        assertRunActive(runId);
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
            previousQAResults: previousQAResults.length > 0 ? previousQAResults : undefined,
            availableTools: readyTools,
          });
          onProgress(`[${runId}] QA task ${task.id}: passed=${qaResult.passed}, issues=${qaResult.issues.length}`);
          previousQAResults.push(qaResult);
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
          const output = buildCardOutput(buildResult.artifacts, task, runId);
          await board.updateCard(cardId, { status: 'DONE', output });
          await board.addCardEvent(cardId, { message: output.summary ?? 'Task passed', type: 'SUCCESS' });
          break;
        }

        if (gateResult.ciSignal === 'escalate') {
          const output = buildCardOutput(buildResult.artifacts, task, runId);
          output.summary = `Escalated after ${iteration} iterations: ${gateResult.diagnosis?.slice(0, 300) ?? 'max retries'}`;
          await board.updateCard(cardId, { status: 'FAILED', output });
          await board.addCardEvent(cardId, {
            message: `Escalated: ${gateResult.diagnosis?.slice(0, 500) ?? 'max iterations'}`,
            type: 'ERROR',
          });
          failedTasks.push(task.id);
          break;
        }

        // no-go → fix
        assertRunActive(runId);
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
            qaIssues: qaResult.issues,
            iteration,
          });
          onProgress(`[${runId}] Task ${task.id} fix complete.`);
        } catch (err) {
          onProgress(`[${runId}] Fix failed on task ${task.id}: ${errMsg(err)}`);
          const output = buildCardOutput(buildResult.artifacts, task, runId);
          output.summary = `Fix failed: ${errMsg(err)}`;
          await board.updateCard(cardId, { status: 'FAILED', output });
          await board.addCardEvent(cardId, { message: `Fix error: ${errMsg(err)}`, type: 'ERROR' });
          failedTasks.push(task.id);
          break;
        }
      }

      if (taskPassed) {
        completedTasks.push(task.id);
        allArtifacts.push(...buildResult.artifacts);
        // Persist artifacts
        for (const artifact of buildResult.artifacts) {
          addRunArtifact(runId, task.id, artifact.path, artifact.type, sandboxPath ?? '', undefined).catch(() => {});
        }
      } else if (!failedTasks.includes(task.id)) {
        const output = buildCardOutput(buildResult.artifacts, task, runId);
        output.summary = `Failed after ${maxIterations} QA iterations.`;
        await board.updateCard(cardId, { status: 'FAILED', output });
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
      const newRecipes = extractRecipes(projectPlan, runId, completedTasks, allBuildLogs, allArtifacts);
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

  } catch (err) {
    if (err instanceof RunStoppedError) {
      onProgress(`[${runId}] Pipeline stopped: ${err.message}`);
      updateRunStatus(runId, 'failed', { diagnosis: `Stopped: ${err.message}` }).catch(() => {});
      return { success: false, diagnosis: `Stopped: ${err.message}` };
    }
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractRecipes(
  projectPlan: ProjectPlan,
  runId: string,
  completedTasks: string[],
  buildLogs?: string[],
  artifacts?: Artifact[],
): RecipeData[] {
  const recipes: RecipeData[] = [];
  const arch = projectPlan.architecture;
  const brief = projectPlan.originalBrief?.toLowerCase() ?? '';

  // Categorize the project
  let category = 'general';
  const text = `${brief} ${arch?.overview ?? ''} ${arch?.techStack ?? ''}`.toLowerCase();
  if (text.includes('website') || text.includes('landing') || text.includes('html') || text.includes('next') || text.includes('react')) category = 'web';
  else if (text.includes('api') || text.includes('server') || text.includes('backend') || text.includes('express')) category = 'api';
  else if (text.includes('cli') || text.includes('command') || text.includes('script')) category = 'cli';
  else if (text.includes('mobile') || text.includes('app')) category = 'mobile';
  else if (text.includes('poem') || text.includes('story') || text.includes('document') || text.includes('write')) category = 'content';

  // Extract actual shell commands from build logs
  const shellCommands = (buildLogs ?? [])
    .filter((l) => l.startsWith('Tool: shell_exec') || l.startsWith('$ ') || l.match(/^(npm |npx |pip |yarn |node |python )/))
    .slice(0, 20);

  // Extract file_write operations from logs
  const fileWrites = (buildLogs ?? [])
    .filter((l) => l.startsWith('Tool: file_write') || l.includes('wrote file:'))
    .slice(0, 15);

  // Get output file list from artifacts
  const outputFiles = (artifacts ?? [])
    .filter((a) => a.type === 'file' && !a.path.includes('node_modules') && !a.path.includes('.git/'))
    .map((a) => a.path)
    .slice(0, 20);

  // Recipe: executable pattern with actual commands
  const briefWords = brief.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
  const recipeId = `recipe-${category}-${briefWords.slice(0, 2).join('-') || runId.slice(0, 8)}`;

  const contentParts: string[] = [
    `Brief: ${projectPlan.originalBrief?.slice(0, 300) ?? 'unknown'}`,
  ];

  // Include tech stack if known
  if (arch?.techStack && arch.techStack !== 'Determined by task requirements') {
    contentParts.push(`Tech Stack: ${arch.techStack}`);
  }

  // Include actual setup commands (the real value)
  if (shellCommands.length > 0) {
    contentParts.push('', 'Setup commands that worked:');
    contentParts.push(...shellCommands.map((c) => `  ${c}`));
  }

  // Include file structure that was produced
  if (outputFiles.length > 0) {
    contentParts.push('', 'Files produced:');
    contentParts.push(...outputFiles.map((f) => `  ${f}`));
  }

  // Include key file writes
  if (fileWrites.length > 0) {
    contentParts.push('', 'File operations:');
    contentParts.push(...fileWrites.map((f) => `  ${f}`));
  }

  // Task descriptions for context
  const taskDescs = projectPlan.phases
    .flatMap((p) => p.tasks)
    .filter((t) => completedTasks.includes(t.id))
    .map((t) => `- [${t.type}] ${t.description.slice(0, 120)}`)
    .join('\n');
  if (taskDescs) {
    contentParts.push('', 'Tasks completed:', taskDescs);
  }

  recipes.push({
    id: recipeId,
    name: `${category}: ${projectPlan.originalBrief?.slice(0, 80) ?? 'unknown'}`,
    category,
    tags: [category, ...briefWords].slice(0, 6),
    content: contentParts.join('\n'),
    source: runId,
  });

  return recipes;
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
