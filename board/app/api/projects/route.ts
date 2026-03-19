import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const projects = await db.project.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { cards: true, runs: true } },
    },
  });

  return NextResponse.json(projects);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const name = (body?.name as string) || `Project ${new Date().toLocaleDateString()}`;
  const description = (body?.description as string) || undefined;

  const project = await db.project.create({
    data: {
      name,
      description,
      members: { connect: { id: session.user.id } },
    },
  });

  // Redirect to projects page after creation
  if (req.headers.get('accept')?.includes('text/html')) {
    return NextResponse.redirect(new URL('/board/projects', req.url));
  }

  return NextResponse.json(project, { status: 201 });
}
