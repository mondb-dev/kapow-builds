import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { CardStatus } from '@prisma/client';
import { userCanAccessCard } from '@/lib/authz';

interface Params {
  params: Promise<{ cardId: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { cardId } = await params;

  const card = await db.card.findUnique({
    where: { id: cardId },
    include: {
      assignee: { select: { id: true, name: true, image: true } },
      creator: { select: { id: true, name: true, image: true } },
      events: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 });
  }

  if (!(await userCanAccessCard(session.user.id, cardId)) && !session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json(card);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { cardId } = await params;

  const card = await db.card.findUnique({ where: { id: cardId } });
  if (!card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 });
  }

  if (!(await userCanAccessCard(session.user.id, cardId)) && !session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();

  const allowedFields = ['status', 'repoUrl', 'deployUrl', 'title', 'description'];
  const updates: Record<string, unknown> = {};

  for (const field of allowedFields) {
    if (field in body) {
      updates[field] = body[field];
    }
  }

  if ('status' in updates && !Object.values(CardStatus).includes(updates.status as CardStatus)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  if (typeof updates.title === 'string' && updates.title.length > 200) {
    return NextResponse.json({ error: 'Title must be 200 characters or fewer' }, { status: 400 });
  }

  if (typeof updates.description === 'string' && updates.description.length > 50000) {
    return NextResponse.json({ error: 'Description must be 50000 characters or fewer' }, { status: 400 });
  }

  for (const urlField of ['repoUrl', 'deployUrl'] as const) {
    if (typeof updates[urlField] === 'string' && updates[urlField] !== '' && !String(updates[urlField]).startsWith('https://')) {
      return NextResponse.json({ error: `${urlField} must start with https://` }, { status: 400 });
    }
  }

  const updated = await db.card.update({
    where: { id: cardId },
    data: updates,
    include: {
      assignee: { select: { id: true, name: true, image: true } },
      creator: { select: { id: true, name: true, image: true } },
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { cardId } = await params;

  const card = await db.card.findUnique({ where: { id: cardId } });
  if (!card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 });
  }

  const canDelete =
    card.creatorId === session.user.id ||
    (card.projectId !== null && await userCanAccessCard(session.user.id, cardId)) ||
    session.user.isAdmin;

  if (!canDelete) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db.card.delete({ where: { id: cardId } });

  return NextResponse.json({ ok: true });
}
