import type { Prisma } from '@prisma/client';
import { db } from './db';

function parseList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

const allowedEmails = () => parseList(process.env.BOARD_ALLOWED_EMAILS);
const allowedUserIds = () => parseList(process.env.BOARD_ALLOWED_USER_IDS);
const adminEmails = () => parseList(process.env.BOARD_ADMIN_EMAILS);
const adminUserIds = () => parseList(process.env.BOARD_ADMIN_USER_IDS);

export function isBoardUserAllowed(user: { id?: string | null; email?: string | null }): boolean {
  const emails = allowedEmails();
  const userIds = allowedUserIds();

  if (emails.size === 0 && userIds.size === 0) {
    return true;
  }

  const email = user.email?.toLowerCase();
  const id = user.id?.toLowerCase();
  return (email !== undefined && emails.has(email)) || (id !== undefined && userIds.has(id));
}

export function isBoardAdmin(user: { id?: string | null; email?: string | null }): boolean {
  const emails = adminEmails();
  const userIds = adminUserIds();
  if (emails.size === 0 && userIds.size === 0) {
    return isBoardUserAllowed(user);
  }
  const email = user.email?.toLowerCase();
  const id = user.id?.toLowerCase();
  return (email !== undefined && emails.has(email)) || (id !== undefined && userIds.has(id));
}

export function projectAccessWhere(userId: string): Prisma.ProjectWhereInput {
  return {
    OR: [
      { members: { some: { id: userId } } },
      { cards: { some: { creatorId: userId } } },
      { cards: { some: { assigneeId: userId } } },
    ],
  };
}

export function cardAccessWhere(userId: string): Prisma.CardWhereInput {
  return {
    OR: [
      { creatorId: userId },
      { assigneeId: userId },
      { project: { is: projectAccessWhere(userId) } },
    ],
  };
}

export function runAccessWhere(userId: string): Prisma.RunWhereInput {
  return {
    project: { is: projectAccessWhere(userId) },
  };
}

export async function userCanAccessProject(userId: string, projectId: string): Promise<boolean> {
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      ...projectAccessWhere(userId),
    },
    select: { id: true },
  });

  return Boolean(project);
}

export async function userCanAccessCard(userId: string, cardId: string): Promise<boolean> {
  const card = await db.card.findFirst({
    where: {
      id: cardId,
      ...cardAccessWhere(userId),
    },
    select: { id: true },
  });

  return Boolean(card);
}

export async function userCanAccessRun(userId: string, runId: string): Promise<boolean> {
  const run = await db.run.findFirst({
    where: {
      id: runId,
      ...runAccessWhere(userId),
    },
    select: { id: true },
  });

  return Boolean(run);
}
