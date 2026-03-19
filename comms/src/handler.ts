import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { createProject } from 'kapow-db/projects';
import { getProjectRecipes, formatRecipesForPrompt } from 'kapow-db/recipes';
import { getProjectPreferences, formatPreferencesForPrompt } from 'kapow-db/preferences';
import { detectIntent } from './intent.js';
import {
  getConversation, createConversation, updateConversation, addMessage,
} from './conversations.js';
import type { ConversationState, UserIntent } from './types.js';

const ACTIONS_URL = process.env.ACTIONS_URL ?? 'http://localhost:3000';
const PLANNER_URL = process.env.PLANNER_URL ?? 'http://localhost:3001';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Reply callback type (injected by Slack bot) ──────────────────────
export type ReplyFn = (text: string) => Promise<void>;

// ── Main entry point ─────────────────────────────────────────────────

export async function handleMessage(
  channelId: string,
  threadTs: string,
  userId: string,
  userName: string,
  text: string,
  reply: ReplyFn,
): Promise<void> {
  // Get or create conversation
  let convo = await getConversation(channelId, threadTs);
  if (!convo) {
    convo = await createConversation(channelId, threadTs, userId, userName);
  }

  addMessage(convo, 'user', text);

  // Detect intent based on current phase
  const intent = await detectIntent(text, convo.phase);

  try {
    switch (convo.phase) {
      case 'idle':
        await handleIdle(convo, intent, reply);
        break;
      case 'scoping':
      case 'planning':
        await reply("I'm still working on the plan, hang tight...");
        break;
      case 'negotiating':
        await handleNegotiating(convo, intent, reply);
        break;
      case 'confirmed':
      case 'building':
        await handleBuilding(convo, intent, reply);
        break;
      case 'done':
      case 'failed':
        await handleCompleted(convo, intent, reply);
        break;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[comms] Error handling message:`, msg);
    addMessage(convo, 'kapow', `Something went wrong: ${msg}`);
    await reply(`Something went wrong: ${msg}`);
  }

  await updateConversation(convo);
}

// ── Phase Handlers ───────────────────────────────────────────────────

async function handleIdle(
  convo: ConversationState,
  intent: UserIntent,
  reply: ReplyFn,
): Promise<void> {
  switch (intent.type) {
    case 'new_project': {
      convo.phase = 'scoping';
      convo.scope = intent.scope;
      addMessage(convo, 'kapow', `Got it. Let me analyze the scope and create a detailed plan...`);
      await reply(`Got it. Let me analyze the scope and create a detailed plan...\n\n> ${intent.scope}`);
      await updateConversation(convo);

      // Call planner asynchronously
      await generatePlan(convo, reply);
      break;
    }
    case 'list_projects': {
      const response = `You can view all projects on the board. What would you like to build?`;
      addMessage(convo, 'kapow', response);
      await reply(response);
      break;
    }
    case 'help': {
      const response = HELP_TEXT;
      addMessage(convo, 'kapow', response);
      await reply(response);
      break;
    }
    default: {
      const response = `Hey ${convo.userName}! Tell me what you'd like to build and I'll create a detailed plan for your review.\n\nFor example: _"Create a REST API for user management with auth, CRUD endpoints, and Postgres"_`;
      addMessage(convo, 'kapow', response);
      await reply(response);
      break;
    }
  }
}

async function handleNegotiating(
  convo: ConversationState,
  intent: UserIntent,
  reply: ReplyFn,
): Promise<void> {
  switch (intent.type) {
    case 'approve': {
      convo.phase = 'confirmed';
      addMessage(convo, 'kapow', 'Plan approved. Starting the build pipeline...');
      await reply('Plan approved. Starting the build pipeline...');
      await updateConversation(convo);

      await startPipeline(convo, reply);
      break;
    }
    case 'reject': {
      convo.phase = 'idle';
      convo.scope = undefined;
      convo.plan = undefined;
      convo.planDetail = undefined;
      const response = `Alright, plan scrapped.${intent.reason ? ` (${intent.reason})` : ''} Let me know when you have a new idea.`;
      addMessage(convo, 'kapow', response);
      await reply(response);
      break;
    }
    case 'modify_scope': {
      convo.phase = 'scoping';
      convo.scope = `${convo.scope}\n\nUser modifications:\n${intent.changes}`;
      addMessage(convo, 'kapow', 'Got it, revising the plan with your changes...');
      await reply('Got it, revising the plan with your changes...');
      await updateConversation(convo);

      await generatePlan(convo, reply);
      break;
    }
    case 'new_project': {
      // User is starting over with a completely new scope
      convo.scope = intent.scope;
      convo.plan = undefined;
      convo.planDetail = undefined;
      convo.phase = 'scoping';
      addMessage(convo, 'kapow', 'New scope received. Replanning...');
      await reply('New scope received. Replanning...');
      await updateConversation(convo);

      await generatePlan(convo, reply);
      break;
    }
    default: {
      const response = 'The plan is ready for your review above. You can:\n• *Approve* — say "go", "approved", "ship it"\n• *Modify* — describe what you want changed\n• *Reject* — say "cancel" or "scrap it"';
      addMessage(convo, 'kapow', response);
      await reply(response);
      break;
    }
  }
}

async function handleBuilding(
  convo: ConversationState,
  intent: UserIntent,
  reply: ReplyFn,
): Promise<void> {
  if (intent.type === 'check_status' || intent.type === 'unknown') {
    if (!convo.runId) {
      await reply('The build is starting up...');
      return;
    }

    try {
      const res = await axios.get(`${ACTIONS_URL}/runs/${convo.runId}/status`, { timeout: 5000 });
      const { status, messages } = res.data as { status: string; messages: string[] };
      const lastMessages = messages.slice(-5).map((m: string) => `> ${m}`).join('\n');
      await reply(`*Status:* ${status}\n\n*Recent activity:*\n${lastMessages}`);
    } catch {
      await reply(`Pipeline is running (run ID: \`${convo.runId}\`). Check the board for live updates.`);
    }
    return;
  }

  await reply("I'm currently building your project. Ask me for a status update or wait for completion.");
}

async function handleCompleted(
  convo: ConversationState,
  intent: UserIntent,
  reply: ReplyFn,
): Promise<void> {
  if (intent.type === 'new_project') {
    // Reset and start over
    convo.phase = 'scoping';
    convo.scope = intent.scope;
    convo.plan = undefined;
    convo.planDetail = undefined;
    convo.runId = undefined;
    addMessage(convo, 'kapow', 'New project! Let me plan this out...');
    await reply('New project! Let me plan this out...');
    await updateConversation(convo);

    await generatePlan(convo, reply);
    return;
  }

  const status = convo.phase === 'done' ? 'completed successfully' : 'failed';
  await reply(`The previous build ${status}. Want to start something new? Just describe what you'd like to build.`);
}

// ── Plan Generation ──────────────────────────────────────────────────

async function generatePlan(convo: ConversationState, reply: ReplyFn): Promise<void> {
  convo.phase = 'planning';
  await updateConversation(convo);

  try {
    // Call the planner service directly
    const planRes = await axios.post(
      `${PLANNER_URL}/plan`,
      {
        runId: `scope-${convo.id}`,
        plan: convo.scope,
      },
      { timeout: 180_000 },
    );

    const projectPlan = planRes.data;
    convo.planDetail = projectPlan;

    // Format plan for Slack
    const formattedPlan = formatPlanForSlack(projectPlan);
    convo.plan = formattedPlan;
    convo.phase = 'negotiating';

    // Derive project name from the plan
    convo.projectName = projectPlan.architecture?.overview?.slice(0, 80) ?? 'Untitled Project';

    addMessage(convo, 'kapow', formattedPlan);
    await reply(formattedPlan);
    await reply('*What do you think?* Reply with:\n• *"go"* or *"approved"* to start building\n• Describe changes you want\n• *"cancel"* to scrap it');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    convo.phase = 'idle';
    addMessage(convo, 'kapow', `Planning failed: ${msg}`);
    await reply(`Planning failed: ${msg}\n\nTry again with a different description?`);
  }

  await updateConversation(convo);
}

function formatPlanForSlack(plan: {
  architecture?: { overview?: string; techStack?: string; fileStructure?: string; conventions?: string };
  phases?: Array<{ name: string; description: string; tasks: Array<{ description: string; acceptanceCriteria: string[] }> }>;
  constraints?: string[];
}): string {
  const lines: string[] = [];

  if (plan.architecture) {
    const a = plan.architecture;
    lines.push('*Architecture*');
    if (a.overview) lines.push(`> ${a.overview}`);
    if (a.techStack) lines.push(`\n*Tech Stack:* ${a.techStack}`);
    if (a.fileStructure) lines.push(`*File Structure:* ${a.fileStructure}`);
    lines.push('');
  }

  if (plan.phases && plan.phases.length > 0) {
    lines.push(`*Phases (${plan.phases.length}):*`);
    for (const phase of plan.phases) {
      lines.push(`\n*${phase.name}* — ${phase.description}`);
      for (const task of phase.tasks) {
        lines.push(`  • ${task.description}`);
        if (task.acceptanceCriteria.length > 0) {
          for (const ac of task.acceptanceCriteria.slice(0, 3)) {
            lines.push(`    ✓ ${ac}`);
          }
          if (task.acceptanceCriteria.length > 3) {
            lines.push(`    _...and ${task.acceptanceCriteria.length - 3} more criteria_`);
          }
        }
      }
    }
    lines.push('');
  }

  if (plan.constraints && plan.constraints.length > 0) {
    lines.push('*Constraints:*');
    for (const c of plan.constraints) {
      lines.push(`  ⚠ ${c}`);
    }
  }

  return lines.join('\n');
}

// ── Pipeline Execution ───────────────────────────────────────────────

async function startPipeline(convo: ConversationState, reply: ReplyFn): Promise<void> {
  convo.phase = 'building';

  try {
    // Create project in DB
    const project = await createProject(
      convo.projectName ?? 'Slack Project',
      convo.scope,
    );
    convo.projectId = project.id;

    // Trigger pipeline via actions HTTP API
    const res = await axios.post(
      `${ACTIONS_URL}/pipeline`,
      { plan: convo.scope, runId: `slack-${convo.id}` },
      { timeout: 10_000 },
    );

    convo.runId = (res.data as { runId: string }).runId;
    addMessage(convo, 'kapow', `Pipeline started (run: \`${convo.runId}\`). I'll update you on progress.`);
    await reply(`Pipeline started (run: \`${convo.runId}\`)\n\nI'll post updates here as the build progresses. You can also track it on the board.`);

    await updateConversation(convo);

    // Start polling for progress updates
    pollPipelineProgress(convo, reply);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    convo.phase = 'failed';
    addMessage(convo, 'kapow', `Failed to start pipeline: ${msg}`);
    await reply(`Failed to start pipeline: ${msg}`);
    await updateConversation(convo);
  }
}

async function pollPipelineProgress(convo: ConversationState, reply: ReplyFn): Promise<void> {
  if (!convo.runId) return;

  let lastMessageCount = 0;
  const pollInterval = 15_000; // 15 seconds
  const maxPolls = 240;        // 1 hour max

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const res = await axios.get(`${ACTIONS_URL}/runs/${convo.runId}/status`, { timeout: 5000 });
      const { status, messages } = res.data as { status: string; messages: string[] };

      // Post new messages to Slack thread
      const newMessages = messages.slice(lastMessageCount);
      if (newMessages.length > 0) {
        // Batch into one message to avoid spam
        const update = newMessages.map((m) => `> ${m}`).join('\n');
        await reply(update);
        lastMessageCount = messages.length;
      }

      if (status === 'done') {
        convo.phase = 'done';
        addMessage(convo, 'kapow', 'Build complete! All tasks passed.');
        await reply('*Build complete!* All tasks passed. Check the board for artifacts and details.');
        await updateConversation(convo);
        return;
      }

      if (status === 'failed') {
        convo.phase = 'failed';
        addMessage(convo, 'kapow', 'Build failed.');
        await reply('*Build failed.* Check the board for details. Want to try again with a modified scope?');
        await updateConversation(convo);
        return;
      }
    } catch {
      // Network error — skip this poll
    }
  }
}

// ── Help Text ────────────────────────────────────────────────────────

const HELP_TEXT = `*Kapow* is an AI development pipeline. Here's how to use me:

*Start a project:*
Tag me and describe what you want to build:
> @kapow Create a REST API for user management with auth and Postgres

*I'll respond with:*
1. A detailed plan with phases, tasks, and architecture
2. You review and negotiate the scope
3. Say "go" when you're happy
4. I build it and post updates here

*Commands:*
• Describe a project → I'll plan it
• "go" / "approved" → Start building
• Describe changes → I'll revise the plan
• "cancel" → Scrap the current plan
• "status" → Check build progress

*Everything happens in this thread* — plan, negotiate, build, done.`;
