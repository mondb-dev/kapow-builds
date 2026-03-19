import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50));
  const skip = (page - 1) * limit;

  const [cards, total] = await Promise.all([
    db.card.findMany({
      include: {
        assignee: { select: { id: true, name: true, image: true } },
        creator: { select: { id: true, name: true, image: true } },
        _count: { select: { events: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    db.card.count(),
  ]);

  return NextResponse.json({ cards, total, page, limit });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { title, description } = body as { title?: string; description?: string };

  if (!title?.trim() || !description?.trim()) {
    return NextResponse.json({ error: 'title and description are required' }, { status: 400 });
  }

  if (title.trim().length > 200) {
    return NextResponse.json({ error: 'Title must be 200 characters or fewer' }, { status: 400 });
  }

  if (description.trim().length > 50000) {
    return NextResponse.json({ error: 'Description must be 50000 characters or fewer' }, { status: 400 });
  }

  const card = await db.card.create({
    data: {
      title: title.trim(),
      description: description.trim(),
      creatorId: session.user.id,
    },
    include: {
      assignee: { select: { id: true, name: true, image: true } },
      creator: { select: { id: true, name: true, image: true } },
      _count: { select: { events: true } },
    },
  });

  return NextResponse.json(card, { status: 201 });
}
