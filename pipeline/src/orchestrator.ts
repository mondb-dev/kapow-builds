/**
 * Consolidated Orchestrator
 *
 * Calls planner, builder, QA, gate as direct functions — no HTTP.
 * The only network calls are to the technician (tool registry)
 * and the board (card management).
 */
import axios from 'axios';
import { mkdirSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'fs';
import { dirname, join, relative } from 'path';
import type {
  ProjectPlan, Phase, Task, Artifact, ProjectContext,
  TaskBuildResult, TaskQAResult, GateResult,
  PipelineResult, AvailableTool, TaskIntent,
} from 'kapow-shared';
import { CommsBus, BoardChannel, type TaskOutput } from 'kapow-shared';
import {
  getProjectRecipes, findRelevantRecipesWithScore, formatRecipesForPrompt, upsertGlobalRecipe,
  type RecipeData, type ScoredRecipe,
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
import { createSandbox, resolveSandboxPath } from './agents/sandbox.js';
import { closeBrowsersForRun } from './tools/browser.js';
import { maybeRequestPlanApproval, maybeRequestSprintReview, type SprintTaskResult } from './approval-gate.js';

const TECHNICIAN_URL = process.env.TECHNICIAN_URL ?? 'http://localhost:3006';
// ── Comms bus (replaces direct BoardClient) ──────────────────────────
// Board is the default channel; additional channels (webhook, Slack, etc.)
// can be registered before calling runPipeline via getCommsBus().register().
const comms = new CommsBus();
comms.register(new BoardChannel());

export function getCommsBus(): CommsBus {
  return comms;
}

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

function isAuditTask(task: Task): boolean {
  return task.intent === 'audit';
}

function ensureArtifact(buildResult: TaskBuildResult, artifact: Artifact): void {
  if (!buildResult.artifacts.some((a) => a.path === artifact.path)) {
    buildResult.artifacts.push(artifact);
  }
}

function writeQaCsvReport(buildResult: TaskBuildResult, qaResult: TaskQAResult): void {
  const reportPath = `reports/${qaResult.taskId}-qa-report.csv`;
  const absPath = resolveSandboxPath(buildResult.sandboxPath, reportPath);
  mkdirSync(dirname(absPath), { recursive: true });

  const escapeCsv = (value: string): string => {
    const clean = value.replace(/\r?\n/g, ' ').trim();
    return `"${clean.replace(/"/g, '""')}"`;
  };

  const rows: string[] = [
    ['task_id', 'status', 'severity', 'file', 'finding', 'delta'].map(escapeCsv).join(','),
  ];

  if (qaResult.issues.length === 0) {
    rows.push([
      qaResult.taskId,
      qaResult.passed ? 'PASS' : 'FAIL',
      'none',
      '',
      qaResult.passed ? 'No issues reported' : 'No explicit issues reported',
      qaResult.delta || '',
    ].map(escapeCsv).join(','));
  } else {
    for (const issue of qaResult.issues) {
      rows.push([
        qaResult.taskId,
        qaResult.passed ? 'PASS' : 'FAIL',
        issue.severity,
        issue.file ?? '',
        issue.description,
        qaResult.delta || '',
      ].map(escapeCsv).join(','));
    }
  }

  writeFileSync(absPath, rows.join('\n') + '\n', 'utf-8');
  ensureArtifact(buildResult, { path: reportPath, type: 'file' });
}

function buildCardOutput(artifacts: Artifact[], task?: Task, runId?: string): TaskOutput {
  const intent = task?.intent ?? 'development';

  // For dev tasks, filter out build system artifacts
  // For non-dev tasks, only filter truly internal paths (.git, Library)
  const isDevIntent = intent === 'development';
  const projectFiles = artifacts.filter((a) => {
    if (a.type !== 'file') return false;
    // Always exclude internal system paths
    if (a.path.includes('.git/') || a.path.includes('Library/') || a.path.startsWith('.')) return false;
    // Only exclude dev build artifacts for development tasks
    if (isDevIntent && (
      a.path.includes('node_modules') ||
      a.path.includes('.cache') ||
      a.path.includes('__pycache__') ||
      a.path.includes('venv/') ||
      a.path.includes('.venv/')
    )) return false;
    return true;
  });

  if (projectFiles.length === 0) {
    return { type: 'summary', summary: `Task completed. ${artifacts.length > 0 ? artifacts.length + ' internal files generated.' : 'No file output.'}`, runId };
  }

  // For dev projects with many files, show summary
  if (isDevIntent && projectFiles.length > 5) {
    const hasProject = projectFiles.some((f) =>
      f.path.includes('package.json') || f.path.includes('server') ||
      f.path.endsWith('.html') || f.path.endsWith('.tsx') || f.path.endsWith('.jsx')
    );
    if (hasProject) {
      return {
        type: 'summary',
        summary: `Built ${projectFiles.length} files.`,
        files: projectFiles.slice(0, 10).map((f) => ({ name: f.path.split('/').pop() ?? f.path, path: f.path })),
        runId,
      };
    }
  }

  // For all outputs, list files
  return {
    type: 'files',
    files: projectFiles.slice(0, 10).map((f) => ({ name: f.path.split('/').pop() ?? f.path, path: f.path })),
    summary: `${projectFiles.length} file${projectFiles.length === 1 ? '' : 's'} produced.`,
    runId,
  };
}

const MAX_WALK_DEPTH = 10;
const MAX_ARTIFACTS = 5000;

function collectArtifacts(sandboxPath: string, intent?: TaskIntent): Artifact[] {
  const artifacts: Artifact[] = [];
  let truncated = false;
  let depthClipped = false;
  // Always skip .git; only skip dev build dirs for development tasks
  const skipDirs = new Set(['.git']);
  if (!intent || intent === 'development') {
    skipDirs.add('node_modules');
    skipDirs.add('dist');
  }
  // Always skip venv dirs regardless of intent
  skipDirs.add('venv');
  skipDirs.add('.venv');

  function walk(dir: string, depth: number): void {
    if (depth > MAX_WALK_DEPTH) { depthClipped = true; return; }
    if (artifacts.length >= MAX_ARTIFACTS) { truncated = true; return; }
    if (!existsSync(dir)) return;

    for (const entry of readdirSync(dir)) {
      if (artifacts.length >= MAX_ARTIFACTS) { truncated = true; return; }
      if (skipDirs.has(entry)) continue;

      const full = join(dir, entry);
      const rel = relative(sandboxPath, full);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        artifacts.push({ path: rel, type: 'directory' });
        walk(full, depth + 1);
      } else {
        artifacts.push({ path: rel, type: 'file' });
      }
    }
  }

  walk(sandboxPath, 0);
  if (truncated) {
    console.warn(`[orchestrator] Artifact list truncated at ${MAX_ARTIFACTS} entries for sandbox ${sandboxPath}`);
  }
  if (depthClipped) {
    console.warn(`[orchestrator] Artifact walk hit depth limit ${MAX_WALK_DEPTH} for sandbox ${sandboxPath}`);
  }
  return artifacts;
}

// ── Pipeline ─────────────────────────────────────────────────────────

export async function runPipeline(
  runId: string,
  plan: string,
  onProgress: (msg: string) => void,
  projectId?: string,
  extraPreferences?: string,
): Promise<PipelineResult> {
  try {

  // ── Step 0: Load recipes, preferences, tools ────────────────────
  const scoredRecipes: ScoredRecipe[] = projectId
    ? (await getProjectRecipes(projectId)).map((r) => ({ ...r, similarity: 0.5 }))
    : await findRelevantRecipesWithScore(plan);
  const recipes = scoredRecipes as RecipeData[];
  const topSimilarity = scoredRecipes.length > 0 ? scoredRecipes[0].similarity : 0;
  const useLocalAI = topSimilarity >= 0.85;
  const preferences = projectId
    ? await getProjectPreferences(projectId)
    : await getGlobalPreferences();
  const recipesText = formatRecipesForPrompt(recipes);
  const preferencesText = [formatPreferencesForPrompt(preferences), extraPreferences].filter(Boolean).join('\n');
  if (scoredRecipes.length > 0) {
    for (const sr of scoredRecipes.slice(0, 3)) {
      onProgress(`[${runId}] 📖 Recipe: "${sr.name.split('\n')[0].slice(0, 60)}" (${(sr.similarity * 100).toFixed(0)}% match)`);
    }
    if (useLocalAI) {
      onProgress(`[${runId}] 🔄 Recipe match ≥85% — switching to local LLM (Ollama).`);
    } else {
      onProgress(`[${runId}] 🌐 Recipe match <85% — using cloud AI.`);
    }
  } else {
    onProgress(`[${runId}] 🆕 No matching recipes — building from scratch with cloud AI.`);
  }
  if (Object.keys(preferences).length > 0) onProgress(`[${runId}] Loaded preferences.`);

  const readyTools = await fetchReadyTools();
  if (readyTools.length > 0) {
    onProgress(`[${runId}] ${readyTools.length} tools available from technician.`);
  }

  updateRunStatus(runId, 'planning').catch(() => {});

  // ── Step 1+2: Reuse existing cards OR plan + create new ones ──
  const cardIds = new Map<string, string>();
  const existingCards = await comms.listTasks(runId);
  const plannedCards = existingCards.filter((c) => c.taskId);
  let projectPlan: ProjectPlan;

  if (plannedCards.length > 0) {
    // Cards already exist from the plan route — try to use stored planData first
    onProgress(`[${runId}] Found ${plannedCards.length} pre-planned cards. Skipping planner.`);

    // Check if Run has stored planner output
    const runRecord = await getRun(runId);
    const storedPlan = runRecord?.planData as { intent?: TaskIntent; phases?: Phase[]; constraints?: string[]; architecture?: ProjectContext } | null;

    if (storedPlan?.phases?.length) {
      // Full planner output available — use it directly
      onProgress(`[${runId}] Using stored planner output (${storedPlan.phases.length} phases).`);
      projectPlan = {
        id: runId,
        originalBrief: plan,
        intent: storedPlan.intent ?? 'development',
        phases: storedPlan.phases,
        constraints: storedPlan.constraints ?? [],
        architecture: storedPlan.architecture ?? {
          overview: plan,
          approach: 'Determined by task requirements',
          structure: 'As specified in tasks',
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
        intent: 'development',
        type: 'code',
        dependencies: [],
        acceptanceCriteria: acLines,
      });
      cardIds.set(card.taskId!, card.id);
    }

    projectPlan = {
      id: runId,
      originalBrief: plan,
      intent: 'development',
      phases: Array.from(phaseMap.values()).map((p) => ({
        ...p,
        description: p.name,
        dependencies: [],
      })),
      constraints: [],
      architecture: {
        overview: plan,
        approach: 'Determined by task requirements',
        structure: 'As specified in tasks',
        conventions: 'Follow standard conventions',
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

    // Create tasks via comms bus (board + all registered channels)
    for (const phase of projectPlan.phases) {
      for (const task of phase.tasks) {
        const record = await comms.createTask({
          title: `[${phase.name}] ${task.description.slice(0, 150)}`,
          description: task.description,
          status: 'BACKLOG',
          runId,
          phaseId: phase.id,
          taskId: task.id,
          projectId,
        });
        cardIds.set(task.id, record.id);
      }
    }
    onProgress(`[${runId}] Tasks created (${comms.channelCount} channel${comms.channelCount === 1 ? '' : 's'}).`);
  }

  // ── Plan approval gate (no-op for board-initiated runs) ─────────
  const approval = await maybeRequestPlanApproval({ runId, plan: projectPlan });
  if (!approval.approved) {
    onProgress(`[${runId}] Plan not approved: ${approval.reason}`);
    updateRunStatus(runId, 'failed', { diagnosis: approval.reason }).catch(() => {});
    return { success: false, diagnosis: approval.reason };
  }

  // ── Step 3: Execute phases ──────────────────────────────────────
  let sandboxPath: string | undefined;
  const completedTasks: string[] = [];
  const failedTasks: string[] = [];
  let allArtifacts: Artifact[] = [];
  const allBuildLogs: string[] = [];
  const isAgileMode = preferencesText.includes('Methodology: agile');
  const sortedPhases = topologicalSort(projectPlan.phases);

  for (let phaseIndex = 0; phaseIndex < sortedPhases.length; phaseIndex++) {
    const phase = sortedPhases[phaseIndex];
    assertRunActive(runId);
    onProgress(`[${runId}] Starting phase: ${phase.name}`);
    const sprintTaskResults: SprintTaskResult[] = [];

    for (const task of topologicalSortTasks(phase.tasks, new Set(completedTasks))) {
      assertRunActive(runId);
      const cardId = cardIds.get(task.id) ?? '';

      // ── Build (direct call) ───────────────────────────────
      await comms.updateStatus(task.id, cardId, 'IN_PROGRESS');
      await comms.addEvent(task.id, cardId, 'Builder started', 'PROGRESS');
      onProgress(`[${runId}] Building task ${task.id}...`);
      updateRunStatus(runId, 'building').catch(() => {});
      addRunLog(runId, 'pipeline', `Building task ${task.id}`, 'info').catch(() => {});

      let buildResult: TaskBuildResult;
      const auditTask = isAuditTask(task);

      if (auditTask) {
        const qaSandbox = sandboxPath ?? createSandbox(`${runId}-${task.id}`);
        sandboxPath = qaSandbox;
        buildResult = {
          runId,
          taskId: task.id,
          sandboxPath: qaSandbox,
          artifacts: [],
          logs: ['Audit task — builder skipped, running QA directly.'],
          success: true,
        };
        onProgress(`[${runId}] Audit task ${task.id}: skipping builder, running QA directly.`);
        await comms.addEvent(task.id, cardId, 'Audit mode: build step skipped.', 'INFO');
      } else {
        try {
          buildResult = await buildTask({
            runId, task, phase,
            architecture: projectPlan.architecture,
            constraints: projectPlan.constraints,
            sandboxPath,
            completedTasks,
            availableTools: readyTools,
            useLocalAI,
          });
          sandboxPath = buildResult.sandboxPath;
          allBuildLogs.push(...buildResult.logs);
          // Log tools used during build
          const toolsUsed = [...new Set(buildResult.logs.filter((l) => l.startsWith('Tool: ')).map((l) => l.match(/^Tool: (\w+)/)?.[1]).filter(Boolean))];
          const aiSource = buildResult.logs.find((l) => l.includes('Switching to local AI')) ? 'local' : 'cloud';
          onProgress(`[${runId}] Task ${task.id} built (${aiSource} AI). ${buildResult.artifacts.length} artifacts. Tools: ${toolsUsed.length > 0 ? toolsUsed.join(', ') : 'none'}`);
        } catch (err) {
          onProgress(`[${runId}] Builder failed on task ${task.id}: ${errMsg(err)}`);
          await comms.updateStatus(task.id, cardId, 'FAILED', { type: 'summary', summary: `Build failed: ${errMsg(err)}` });
          await comms.addEvent(task.id, cardId, `Build error: ${errMsg(err)}`, 'ERROR');
          failedTasks.push(task.id);
          continue;
        }
      }

      // ── Skip QA for simple dev file/shell tasks ─────────────
      const taskIntent = task.intent ?? 'development';
      const isSimpleDevTask = taskIntent === 'development' && (task.type === 'file' || task.type === 'shell');

      if (isSimpleDevTask && buildResult.success) {
        // For simple dev file/shell tasks, verify output exists and skip QA
        const output = buildCardOutput(buildResult.artifacts, task, runId);
        const hasOutput = output.files && output.files.length > 0;
        if (hasOutput) {
          onProgress(`[${runId}] Simple task ${task.id} — skipping QA.`);
          await comms.updateStatus(task.id, cardId, 'DONE', output);
          await comms.addEvent(task.id, cardId, output.summary ?? 'Task completed', 'SUCCESS');
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
      let lastQAResult: TaskQAResult | undefined;

      while (iteration < maxIterations) {
        iteration++;

        // QA
        assertRunActive(runId);
        await comms.updateStatus(task.id, cardId, 'QA');
        await comms.addEvent(task.id, cardId, `QA check (iteration ${iteration})`, 'PROGRESS');
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
          writeQaCsvReport(buildResult, qaResult);
          const refreshed = collectArtifacts(buildResult.sandboxPath, taskIntent);
          for (const artifact of refreshed) {
            ensureArtifact(buildResult, artifact);
          }
          previousQAResults.push(qaResult);
          lastQAResult = qaResult;
        } catch (err) {
          onProgress(`[${runId}] QA failed on task ${task.id}: ${errMsg(err)}`);
          await comms.addEvent(task.id, cardId, `QA error: ${errMsg(err)}`, 'ERROR');
          break;
        }

        // Gate
        let gateResult: GateResult;
        try {
          gateResult = await gateEvaluate(runId, qaResult, iteration);
          onProgress(`[${runId}] Gate task ${task.id}: ${gateResult.ciSignal}`);
        } catch (err) {
          onProgress(`[${runId}] Gate failed on task ${task.id}: ${errMsg(err)}`);
          await comms.addEvent(task.id, cardId, `Gate error: ${errMsg(err)}`, 'ERROR');
          break;
        }

        if (gateResult.ciSignal === 'go') {
          taskPassed = true;
          const output = buildCardOutput(buildResult.artifacts, task, runId);
          await comms.updateStatus(task.id, cardId, 'DONE', output);
          await comms.addEvent(task.id, cardId, output.summary ?? 'Task passed', 'SUCCESS');
          break;
        }

        if (gateResult.ciSignal === 'escalate') {
          const output = buildCardOutput(buildResult.artifacts, task, runId);
          output.summary = `Escalated after ${iteration} iterations: ${gateResult.diagnosis?.slice(0, 300) ?? 'max retries'}`;
          await comms.updateStatus(task.id, cardId, 'FAILED', output);
          await comms.addEvent(task.id, cardId, `Escalated: ${gateResult.diagnosis?.slice(0, 500) ?? 'max iterations'}`, 'ERROR');
          failedTasks.push(task.id);
          break;
        }

        // no-go → fix
        assertRunActive(runId);
        await comms.updateStatus(task.id, cardId, 'IN_PROGRESS');
        await comms.addEvent(task.id, cardId, `Fix needed (iteration ${iteration}): ${gateResult.delta?.slice(0, 300) ?? ''}`, 'PROGRESS');
        onProgress(`[${runId}] Fixing task ${task.id} (iteration ${iteration})...`);

        if (auditTask) {
          // Audit tasks evaluate external artifacts — there is no build to "fix".
          // Re-running QA with the same inputs would just burn tokens for the
          // same verdict, so escalate on first no-go.
          const output = buildCardOutput(buildResult.artifacts, task, runId);
          output.summary = `Audit task did not pass: ${gateResult.diagnosis?.slice(0, 300) ?? 'criteria not met'}`;
          await comms.updateStatus(task.id, cardId, 'FAILED', output);
          await comms.addEvent(task.id, cardId, `Audit failed (no retry): ${gateResult.diagnosis?.slice(0, 500) ?? 'criteria not met'}`, 'ERROR');
          failedTasks.push(task.id);
          break;
        } else {
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
            await comms.updateStatus(task.id, cardId, 'FAILED', output);
            await comms.addEvent(task.id, cardId, `Fix error: ${errMsg(err)}`, 'ERROR');
            failedTasks.push(task.id);
            break;
          }
        }
      }

      if (taskPassed) {
        completedTasks.push(task.id);
        allArtifacts.push(...buildResult.artifacts);
        for (const artifact of buildResult.artifacts) {
          addRunArtifact(runId, task.id, artifact.path, artifact.type, sandboxPath ?? '', undefined).catch(() => {});
        }
      } else if (!failedTasks.includes(task.id)) {
        const output = buildCardOutput(buildResult.artifacts, task, runId);
        output.summary = `Failed after ${maxIterations} QA iterations.`;
        await comms.updateStatus(task.id, cardId, 'FAILED', output);
        await comms.addEvent(task.id, cardId, 'Max iterations reached', 'ERROR');
        failedTasks.push(task.id);
      }

      // Collect sprint result for this task
      sprintTaskResults.push({
        taskId: task.id,
        description: task.description,
        passed: taskPassed,
        qaIterations: iteration,
        qaIssues: lastQAResult?.issues.map((i) => `[${i.severity}] ${i.description}`).filter(Boolean) ?? [],
      });
    }

    // ── Agile: sprint review gate between phases ────────────────
    const isLastPhase = phaseIndex === sortedPhases.length - 1;
    if (isAgileMode && !isLastPhase) {
      const nextPhase = sortedPhases[phaseIndex + 1];
      onProgress(`[${runId}] Sprint ${phaseIndex + 1} complete. Awaiting review...`);
      const sprintOutcome = await maybeRequestSprintReview({
        runId,
        sprintIndex: phaseIndex,
        phase,
        nextPhase,
        taskResults: sprintTaskResults,
      });
      if (!sprintOutcome.approved) {
        onProgress(`[${runId}] Sprint review: ${sprintOutcome.reason}`);
        updateRunStatus(runId, 'failed', { diagnosis: sprintOutcome.reason }).catch(() => {});
        return { success: false, diagnosis: sprintOutcome.reason };
      }
      onProgress(`[${runId}] Sprint ${phaseIndex + 1} approved. Starting Sprint ${phaseIndex + 2}...`);
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
      for (const recipe of newRecipes) {
        onProgress(`[${runId}] 📝 Saved recipe: "${recipe.name.split('\n')[0].slice(0, 60)}" [${recipe.category}]`);
      }
    } catch (err) {
      onProgress(`[${runId}] Recipe save failed (non-fatal): ${errMsg(err)}`);
    }

    const deployUrl = allBuildLogs
      .map((l) => l.match(/Result:\s*(Deployed to [^:]+:\s*(https:\/\/\S+))/i))
      .filter(Boolean)
      .map((m) => m![2])
      .pop();

    const completionMsg = deployUrl
      ? `All ${completedTasks.length} tasks passed. Live at: ${deployUrl}`
      : `All ${completedTasks.length} tasks passed.`;

    await comms.pipelineComplete(runId, true, completionMsg);
    return { success: true, artifacts: allArtifacts, projectPlan };
  }

  const failSummary = `${failedTasks.length} tasks failed: ${failedTasks.join(', ')}`;
  onProgress(`[${runId}] Pipeline finished with ${failSummary}`);
  updateRunStatus(runId, 'failed', { completedTasks, failedTasks }).catch(() => {});
  await comms.pipelineComplete(runId, false, failSummary);
  return {
    success: false,
    artifacts: allArtifacts,
    failedTasks,
    projectPlan,
    diagnosis: failSummary,
  };

  } catch (err) {
    if (err instanceof RunStoppedError) {
      onProgress(`[${runId}] Pipeline stopped: ${err.message}`);
      updateRunStatus(runId, 'failed', { diagnosis: `Stopped: ${err.message}` }).catch(() => {});
      return { success: false, diagnosis: `Stopped: ${err.message}` };
    }
    throw err;
  } finally {
    // Drop any per-run browser contexts so cookies/storage don't leak across runs.
    await closeBrowsersForRun(runId).catch(() => {});
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

  // Categorize the project — use intent if available, fall back to text heuristics
  let category: string = projectPlan.intent ?? 'general';
  if (category === 'general' || category === 'development') {
    const text = `${brief} ${arch?.overview ?? ''} ${arch?.approach ?? ''}`.toLowerCase();
    if (text.includes('website') || text.includes('landing') || text.includes('html') || text.includes('next') || text.includes('react')) category = 'web';
    else if (text.includes('api') || text.includes('server') || text.includes('backend') || text.includes('express')) category = 'api';
    else if (text.includes('cli') || text.includes('command') || text.includes('script')) category = 'cli';
    else if (text.includes('mobile') || text.includes('app')) category = 'mobile';
    else if (category === 'general') category = 'development';
  }

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

  // Include approach/methodology if known
  if (arch?.approach && arch.approach !== 'Determined by task requirements') {
    contentParts.push(`Approach: ${arch.approach}`);
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
    .map((t) => `- [${t.intent ?? t.type}] ${t.description.slice(0, 120)}`)
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
  function visit(id: string, fromId?: string) {
    if (visited.has(id)) return;
    const p = map.get(id);
    if (!p) {
      throw new Error(
        `Phase "${fromId ?? '?'}" depends on missing phase "${id}". ` +
        `Known phases: ${[...map.keys()].join(', ')}`
      );
    }
    visited.add(id);
    for (const dep of p.dependencies ?? []) visit(dep, id);
    result.push(p);
  }
  for (const p of phases) visit(p.id);
  return result;
}

function topologicalSortTasks(tasks: Task[], completedTaskIds?: Set<string>): Task[] {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const result: Task[] = [];
  function visit(id: string, fromId?: string) {
    if (visited.has(id)) return;
    const t = map.get(id);
    if (!t) {
      // Cross-phase dependency — already completed or unknown; skip silently
      if (completedTaskIds?.has(id)) return;
      console.warn(`[orchestrator] Task "${fromId ?? '?'}" references unknown task "${id}" — skipping dependency`);
      return;
    }
    visited.add(id);
    for (const dep of t.dependencies ?? []) visit(dep, id);
    result.push(t);
  }
  for (const t of tasks) visit(t.id);
  return result;
}
