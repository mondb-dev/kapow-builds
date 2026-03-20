import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { CardDetail } from '@/components/CardDetail';
import { userCanAccessCard } from '@/lib/authz';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ cardId: string }>;
}

export default async function CardPage({ params }: Props) {
  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  const { cardId } = await params;

  if (!(await userCanAccessCard(session.user.id, cardId)) && !session.user.isAdmin) {
    notFound();
  }

  const card = await db.card.findUnique({
    where: { id: cardId },
    include: {
      assignee: { select: { id: true, name: true, image: true } },
      creator: { select: { id: true, name: true, image: true } },
      events: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!card) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm px-6 py-3">
        <div className="flex items-center gap-3">
          <a href="/board" className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            Board
          </a>
          <span className="text-gray-700">/</span>
          <span className="text-sm text-gray-300 truncate max-w-sm">{card.title}</span>
        </div>
      </header>

      <CardDetail
        card={JSON.parse(JSON.stringify(card))}
        currentUserId={session.user.id}
        currentUserName={session.user.name ?? 'You'}
        currentUserImage={session.user.image ?? null}
      />
    </div>
  );
}
