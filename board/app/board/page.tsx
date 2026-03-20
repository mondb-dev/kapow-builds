import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { Board } from '@/components/Board';
import Link from 'next/link';
import { cardAccessWhere } from '@/lib/authz';

export const dynamic = 'force-dynamic';

export default async function BoardPage() {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  const cards = await db.card.findMany({
    where: cardAccessWhere(session.user.id),
    include: {
      assignee: { select: { id: true, name: true, image: true } },
      creator: { select: { id: true, name: true, image: true } },
      _count: { select: { events: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div className="h-screen flex flex-col bg-gray-950 overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <svg className="w-4.5 h-4.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-white tracking-tight">Kapow Board</h1>
          </div>

          <nav className="flex items-center gap-4 text-sm">
            <Link href="/board/projects" className="text-gray-400 hover:text-white transition-colors">Projects</Link>
            <Link href="/board/runs" className="text-gray-400 hover:text-white transition-colors">Runs</Link>
            <Link href="/board/knowledge" className="text-gray-400 hover:text-white transition-colors">Knowledge</Link>
            {session.user.isAdmin && (
              <>
                <Link href="/board/logs" className="text-gray-400 hover:text-white transition-colors">Logs</Link>
                <Link href="/board/security" className="text-gray-400 hover:text-white transition-colors">Security</Link>
              </>
            )}
          </nav>

          <div className="flex items-center gap-3">
            {session.user.image && (
              <img
                src={session.user.image}
                alt={session.user.name ?? 'User'}
                className="w-8 h-8 rounded-full border border-gray-700"
              />
            )}
            <span className="text-sm text-gray-400">{session.user.name}</span>
          </div>
        </div>
      </header>

      {/* Board */}
      <Board
        initialCards={JSON.parse(JSON.stringify(cards))}
        currentUserId={session.user.id}
        currentUserName={session.user.name ?? 'You'}
      />
    </div>
  );
}
