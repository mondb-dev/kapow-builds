import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { Board } from '@/components/Board';
import { AssignAllButton } from '@/components/AssignAllButton';
import Link from 'next/link';
import { userCanAccessProject } from '@/lib/authz';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectKanbanPage({ params }: Params) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const { projectId } = await params;

  if (!(await userCanAccessProject(session.user.id, projectId)) && !session.user.isAdmin) {
    notFound();
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, repoUrl: true },
  });

  if (!project) notFound();

  const cards = await db.card.findMany({
    where: { projectId },
    include: {
      assignee: { select: { id: true, name: true, image: true } },
      creator: { select: { id: true, name: true, image: true } },
      _count: { select: { events: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const unassignedCount = cards.filter((c) => c.assigneeType === 'UNASSIGNED').length;

  return (
    <div className="h-screen flex flex-col bg-gray-950 overflow-hidden">
      <header className="flex-shrink-0 border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href={`/board/projects/${projectId}`} className="text-gray-400 hover:text-white text-sm">
              ← {project.name}
            </Link>
            <span className="text-gray-600">|</span>
            <h1 className="text-lg font-semibold text-white tracking-tight">Board</h1>
            <span className="text-xs text-gray-500">{cards.length} cards</span>
          </div>

          <div className="flex items-center gap-3">
            {unassignedCount > 0 && (
              <AssignAllButton projectId={projectId} count={unassignedCount} />
            )}
            {project.repoUrl && (
              <a href={project.repoUrl} target="_blank" rel="noopener" className="text-xs text-gray-400 hover:text-blue-400">
                GitHub ↗
              </a>
            )}
            <Link href="/board" className="text-xs text-gray-500 hover:text-white">
              All Cards
            </Link>
            {session.user.image && (
              <img src={session.user.image} alt={session.user.name ?? 'User'} className="w-7 h-7 rounded-full border border-gray-700" />
            )}
          </div>
        </div>
      </header>

      <Board
        initialCards={JSON.parse(JSON.stringify(cards))}
        currentUserId={session.user.id}
        currentUserName={session.user.name ?? 'You'}
      />
    </div>
  );
}
