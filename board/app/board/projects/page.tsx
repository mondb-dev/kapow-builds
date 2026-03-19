import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import Link from 'next/link';


export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const projects = await db.project.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { cards: true, runs: true } },
    },
  });

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/board" className="text-gray-400 hover:text-white text-sm">
              ← Board
            </Link>
            <h1 className="text-lg font-semibold">Projects</h1>
          </div>
          <NewProjectButton />
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-6">
        {projects.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <p className="text-lg">No projects yet</p>
            <p className="text-sm mt-2">Create one from the board or via Slack</p>
          </div>
        ) : (
          <div className="space-y-3">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/board/projects/${project.id}`}
                className="block bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-blue-500/50 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="font-medium text-white">{project.name}</h2>
                    {project.description && (
                      <p className="text-sm text-gray-400 mt-1 line-clamp-2">{project.description}</p>
                    )}
                  </div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span>{project._count.cards} cards</span>
                    <span>{project._count.runs} runs</span>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
                  {project.repoUrl && (
                    <span className="hover:text-blue-400">Repository ↗</span>
                  )}
                  <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function NewProjectButton() {
  return (
    <Link
      href="/board/projects/new"
      className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded-md font-medium transition-colors"
    >
      + New Project
    </Link>
  );
}
