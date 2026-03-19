import { prisma } from 'kapow-db/client';
import type { ConversationState, ConversationMessage, ConversationPhase } from './types.js';

// In-memory conversation cache (DB-backed for persistence across restarts)
const cache = new Map<string, ConversationState>();

function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

export async function getConversation(
  channelId: string,
  threadTs: string,
): Promise<ConversationState | null> {
  const key = threadKey(channelId, threadTs);
  if (cache.has(key)) return cache.get(key)!;

  // Check DB
  const row = await prisma.conversation.findUnique({
    where: { channelId_threadTs: { channelId, threadTs } },
  });

  if (row) {
    const state: ConversationState = {
      id: row.id,
      channelId: row.channelId,
      threadTs: row.threadTs,
      userId: row.userId,
      userName: row.userName,
      phase: row.phase as ConversationPhase,
      projectName: row.projectName ?? undefined,
      projectId: row.projectId ?? undefined,
      runId: row.runId ?? undefined,
      scope: row.scope ?? undefined,
      plan: row.plan ?? undefined,
      planDetail: row.planDetail ?? undefined,
      messages: (row.messages as ConversationMessage[]) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    cache.set(key, state);
    return state;
  }

  return null;
}

export async function createConversation(
  channelId: string,
  threadTs: string,
  userId: string,
  userName: string,
): Promise<ConversationState> {
  const now = new Date().toISOString();
  const state: ConversationState = {
    id: '',
    channelId,
    threadTs,
    userId,
    userName,
    phase: 'idle',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  const row = await prisma.conversation.create({
    data: {
      channelId,
      threadTs,
      userId,
      userName,
      phase: 'idle',
      messages: [],
    },
  });

  state.id = row.id;
  cache.set(threadKey(channelId, threadTs), state);
  return state;
}

export async function updateConversation(state: ConversationState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  cache.set(threadKey(state.channelId, state.threadTs), state);

  await prisma.conversation.update({
    where: { id: state.id },
    data: {
      phase: state.phase,
      projectName: state.projectName ?? null,
      projectId: state.projectId ?? null,
      runId: state.runId ?? null,
      scope: state.scope ?? null,
      plan: state.plan ?? null,
      planDetail: state.planDetail ? (state.planDetail as Record<string, unknown>) : undefined,
      messages: state.messages as unknown[],
    },
  });
}

export function addMessage(
  state: ConversationState,
  role: 'user' | 'kapow',
  text: string,
): void {
  state.messages.push({
    role,
    text,
    timestamp: new Date().toISOString(),
  });
}
