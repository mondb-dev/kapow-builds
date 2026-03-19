import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const statusColors: Record<string, string> = {
  PENDING: 'text-gray-400 bg-gray-400/10',
  PLANNING: 'text-blue-400 bg-blue-400/10',
  BUILDING: 'text-blue-400 bg-blue-400/10',
  QA: 'text-amber-400 bg-amber-400/10',
  GATE: 'text-amber-400 bg-amber-400/10',
  DONE: 'text-green-400 bg-green-400/10',
  FAILED: 'text-red-400 bg-red-400/10',
};

export default async function RunsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const runs = await db.run.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      project: { select: { name: true } },
      _count: { select: { logs: true, artifacts: true, cards: true } },
    },
  });

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/board" className="text-gray-400 hover:text-white text-sm">
            ← Board
          </Link>
          <h1 className="text-lg font-semibold">Pipeline Runs</h1>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6">
        {runs.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <p className="text-lg">No runs yet</p>
            <p className="text-sm mt-2">Runs appear here when you trigger a build from the board or Slack</p>
          </div>
        ) : (
          <div className="space-y-3">
            {runs.map((run) => (
              <div
                key={run.id}
                className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${statusColors[run.status] ?? 'text-gray-400'}`}>
                        {run.status}
                      </span>
                      {run.project && (
                        <span className="text-sm text-gray-400">{run.project.name}</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-300 mt-2 line-clamp-2">{run.plan}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                  <span>{run._count.cards} tasks</span>
                  <span>{run._count.artifacts} artifacts</span>
                  <span>{run._count.logs} log entries</span>
                  <span className="ml-auto">{new Date(run.createdAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
