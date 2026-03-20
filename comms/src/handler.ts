import axios from 'axios';
import { createProject } from 'kapow-db/projects';
import { KAPOW_LINES, getInternalAuthHeaders } from 'kapow-shared';
import { detectIntent } from './intent.js';
import {
  getConversation, createConversation, updateConversation, addMessage,
} from './conversations.js';
import { formatPlan, formatPrompt, type PlanData } from './channels/formatter.js';
import type { ConversationState, UserIntent } from './types.js';

const ACTIONS_URL = process.env.ACTIONS_URL ?? 'http://localhost:3000';
const PLANNER_URL = process.env.PLANNER_URL ?? 'http://localhost:3001';

// ── Reply callback type (injected by channel adapter) ────────────────
export type ReplyFn = (text: string) => Promise<void>;

// ── Platform hint (set per-conversation for formatting) ──────────────
export type Platform = 'slack' | 'discord' | 'plain';

// ── Shorthand ────────────────────────────────────────────────────────
const K = KAPOW_LINES;

// ── Main entry point ─────────────────────────────────────────────────

export async function handleMessage(
  channelId: string,
  threadTs: string,
  userId: string,
  userName: string,
  text: string,
  reply: ReplyFn,
  platform: Platform = 'plain',
): Promise<void> {
  let convo = await getConversation(channelId, threadTs);
  if (!convo) {
    convo = await createConversation(channelId, threadTs, userId, userName);
  }

  addMessage(convo, 'user', text);

  try {
    const intent = await detectIntent(text, convo.phase);

    switch (convo.phase) {
      case 'idle':
        await handleIdle(convo, intent, reply, platform);
        break;
      case 'scoping':
      case 'planning':
        await say(convo, reply, K.planningStart);
        break;
      case 'negotiating':
        await handleNegotiating(convo, intent, reply, platform);
        break;
      case 'confirmed':
      case 'building':
        await handleBuilding(convo, intent, reply);
        break;
      case 'done':
      case 'failed':
        await handleCompleted(convo, intent, reply, platform);
        break;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[comms] Error:`, msg);
    await say(convo, reply, K.error(msg));
  }

  await updateConversation(convo);
}

// ── Helper: say something as Kapow ───────────────────────────────────

async function say(convo: ConversationState, reply: ReplyFn, text: string): Promise<void> {
  addMessage(convo, 'kapow', text);
  await reply(text);
}

// ── Phase Handlers ───────────────────────────────────────────────────

async function handleIdle(
  convo: ConversationState,
  intent: UserIntent,
  reply: ReplyFn,
  platform: Platform,
): Promise<void> {
  switch (intent.type) {
    case 'new_project': {
      convo.phase = 'scoping';
      convo.scope = intent.scope;
      await say(convo, reply, K.planningStart);
      await updateConversation(convo);
      await generatePlan(convo, reply, platform);
      break;
    }
    case 'list_projects': {
      await say(convo, reply, `Projects are on the board. You got something new for me, or what?`);
      break;
    }
    case 'help': {
      await say(convo, reply, K.help);
      break;
    }
    default: {
      await say(convo, reply, K.greeting(convo.userName));
      break;
    }
  }
}

async function handleNegotiating(
  convo: ConversationState,
  intent: UserIntent,
  reply: ReplyFn,
  platform: Platform,
): Promise<void> {
  switch (intent.type) {
    case 'approve': {
      convo.phase = 'confirmed';
      await say(convo, reply, K.approved);
      await updateConversation(convo);
      await startPipeline(convo, reply);
      break;
    }
    case 'reject': {
      convo.phase = 'idle';
      convo.scope = undefined;
      convo.plan = undefined;
      convo.planDetail = undefined;
      await say(convo, reply, K.rejected);
      break;
    }
    case 'modify_scope': {
      convo.phase = 'scoping';
      convo.scope = `${convo.scope}\n\nUser modifications:\n${intent.changes}`;
      await say(convo, reply, K.planRevising);
      await updateConversation(convo);
      await generatePlan(convo, reply, platform);
      break;
    }
    case 'new_project': {
      convo.scope = intent.scope;
      convo.plan = undefined;
      convo.planDetail = undefined;
      convo.phase = 'scoping';
      await say(convo, reply, `New job? Alright, scrapping the old plan. Give me a sec.`);
      await updateConversation(convo);
      await generatePlan(convo, reply, platform);
      break;
    }
    default: {
      await say(convo, reply, `The plan's up there. Say "go" to build, tell me what to change, or "cancel" to scrap it. Your call.`);
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
      await say(convo, reply, `Warming up. Hold on.`);
      return;
    }

    try {
      const res = await axios.get(`${ACTIONS_URL}/runs/${convo.runId}/status`, {
        timeout: 5000,
        headers: getInternalAuthHeaders(),
      });
      const { status, messages } = res.data as { status: string; messages: string[] };
      const lastMessages = messages.slice(-5).map((m: string) => `> ${m}`).join('\n');
      await say(convo, reply, `Status: *${status}*. ${K.statusRunning}\n\n${lastMessages}`);
    } catch {
      await say(convo, reply, `Pipeline's running. Run \`${convo.runId}\`. ${K.statusRunning}`);
    }
    return;
  }

  await say(convo, reply, K.buildProgress);
}

async function handleCompleted(
  convo: ConversationState,
  intent: UserIntent,
  reply: ReplyFn,
  platform: Platform,
): Promise<void> {
  if (intent.type === 'new_project') {
    convo.phase = 'scoping';
    convo.scope = intent.scope;
    convo.plan = undefined;
    convo.planDetail = undefined;
    convo.runId = undefined;
    await say(convo, reply, `Another one? Let's go.`);
    await updateConversation(convo);
    await generatePlan(convo, reply, platform);
    return;
  }

  if (convo.phase === 'done') {
    await say(convo, reply, `Last build's done. ${K.statusIdle}`);
  } else {
    await say(convo, reply, `Last one didn't make it. Wanna take another shot? Describe the job.`);
  }
}

// ── Plan Generation ──────────────────────────────────────────────────

async function generatePlan(convo: ConversationState, reply: ReplyFn, platform: Platform = 'plain'): Promise<void> {
  convo.phase = 'planning';
  await updateConversation(convo);

  try {
    const planRes = await axios.post(
      `${PLANNER_URL}/plan`,
      { runId: `scope-${convo.id}`, plan: convo.scope },
      { timeout: 180_000 },
    );

    const projectPlan = planRes.data;
    convo.planDetail = projectPlan;

    const formattedPlan = formatPlan(projectPlan as PlanData, platform);
    convo.plan = formattedPlan;
    convo.phase = 'negotiating';
    convo.projectName = projectPlan.architecture?.overview?.slice(0, 80) ?? 'Untitled Project';

    addMessage(convo, 'kapow', formattedPlan);
    await reply(formattedPlan);
    await reply(`${K.planReady}\n\n${formatPrompt(platform)}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    convo.phase = 'idle';
    await say(convo, reply, K.error(`Planner choked: ${msg}. Try describing it differently.`));
  }

  await updateConversation(convo);
}

// ── Pipeline Execution ───────────────────────────────────────────────

async function startPipeline(convo: ConversationState, reply: ReplyFn): Promise<void> {
  convo.phase = 'building';

  try {
    const project = await createProject(
      convo.projectName ?? 'Slack Project',
      convo.scope,
    );
    convo.projectId = project.id;

    const res = await axios.post(
      `${ACTIONS_URL}/pipeline`,
      { plan: convo.scope, runId: `slack-${convo.id}`, projectId: project.id },
      {
        timeout: 10_000,
        headers: getInternalAuthHeaders(),
      },
    );

    convo.runId = (res.data as { runId: string }).runId;
    await say(convo, reply, K.buildStarted(convo.runId));

    await updateConversation(convo);
    pollPipelineProgress(convo, reply);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    convo.phase = 'failed';
    await say(convo, reply, K.error(`Pipeline wouldn't start: ${msg}`));
    await updateConversation(convo);
  }
}

async function pollPipelineProgress(convo: ConversationState, reply: ReplyFn): Promise<void> {
  if (!convo.runId) return;

  let lastMessageCount = 0;
  const pollInterval = 15_000;
  const maxPolls = 240;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const res = await axios.get(`${ACTIONS_URL}/runs/${convo.runId}/status`, {
        timeout: 5000,
        headers: getInternalAuthHeaders(),
      });
      const { status, messages } = res.data as { status: string; messages: string[] };

      const newMessages = messages.slice(lastMessageCount);
      if (newMessages.length > 0) {
        const update = newMessages.map((m) => `> ${m}`).join('\n');
        await reply(update);
        lastMessageCount = messages.length;
      }

      if (status === 'done') {
        convo.phase = 'done';
        await say(convo, reply, K.buildDone);
        await updateConversation(convo);
        return;
      }

      if (status === 'failed') {
        convo.phase = 'failed';
        await say(convo, reply, K.buildFailed);
        await updateConversation(convo);
        return;
      }
    } catch {
      // Skip
    }
  }
}
