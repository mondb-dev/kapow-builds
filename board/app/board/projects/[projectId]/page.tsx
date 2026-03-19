import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ projectId: string }>;
}

async function renameProject(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) return;

  const id = formData.get('id') as string;
  const name = formData.get('name') as string;
  if (!id || !name?.trim()) return;

  await db.project.update({
    where: { id },
    data: { name: name.trim() },
  });

  revalidatePath(`/board/projects/${id}`);
  revalidatePath('/board/projects');
}

async function updateDescription(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) return;

  const id = formData.get('id') as string;
  const description = formData.get('description') as string;
  if (!id) return;

  await db.project.update({
    where: { id },
    data: { description: description?.trim() || null },
  });

  revalidatePath(`/board/projects/${id}`);
}

async function updateRepoUrl(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) return;

  const id = formData.get('id') as string;
  const repoUrl = formData.get('repoUrl') as string;
  if (!id) return;

  await db.project.update({
    where: { id },
    data: { repoUrl: repoUrl?.trim() || null },
  });

  revalidatePath(`/board/projects/${id}`);
}

async function deleteProject(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) return;

  const id = formData.get('id') as string;
  if (!id) return;

  await db.project.delete({ where: { id } });

  redirect('/board/projects');
}

export default async function ProjectDetailPage({ params }: Params) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const { projectId } = await params;

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      cards: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, title: true, status: true, createdAt: true },
      },
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, status: true, plan: true, createdAt: true },
      },
      _count: { select: { cards: true, runs: true } },
    },
  });

  if (!project) notFound();

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/board/projects" className="text-gray-400 hover:text-white text-sm">
            ← Projects
          </Link>
          <h1 className="text-lg font-semibold">{project.name}</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-6 space-y-8">
        {/* Name */}
        <section>
          <label className="text-xs text-gray-500 uppercase tracking-wide">Project Name</label>
          <form action={renameProject} className="flex gap-2 mt-1">
            <input type="hidden" name="id" value={project.id} />
            <input
              name="name"
              defaultValue={project.name}
              className="flex-1 bg-gray-900 border border-gray-800 rounded-md px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
            />
            <button type="submit" className="px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-md">
              Save
            </button>
          </form>
        </section>

        {/* Description */}
        <section>
          <label className="text-xs text-gray-500 uppercase tracking-wide">Description</label>
          <form action={updateDescription} className="flex gap-2 mt-1">
            <input type="hidden" name="id" value={project.id} />
            <textarea
              name="description"
              defaultValue={project.description ?? ''}
              rows={3}
              placeholder="What is this project about?"
              className="flex-1 bg-gray-900 border border-gray-800 rounded-md px-3 py-2 text-white focus:border-blue-500 focus:outline-none resize-none"
            />
            <button type="submit" className="px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-md self-end">
              Save
            </button>
          </form>
        </section>

        {/* Repo URL */}
        <section>
          <label className="text-xs text-gray-500 uppercase tracking-wide">Repository URL</label>
          <form action={updateRepoUrl} className="flex gap-2 mt-1">
            <input type="hidden" name="id" value={project.id} />
            <input
              name="repoUrl"
              defaultValue={project.repoUrl ?? ''}
              placeholder="https://github.com/..."
              className="flex-1 bg-gray-900 border border-gray-800 rounded-md px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
            />
            <button type="submit" className="px-3 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-md">
              Save
            </button>
          </form>
        </section>

        {/* Recent Cards */}
        <section>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            Recent Cards ({project._count.cards})
          </h2>
          {project.cards.length === 0 ? (
            <p className="text-gray-600 text-sm">No cards yet</p>
          ) : (
            <div className="space-y-2">
              {project.cards.map((card) => (
                <Link
                  key={card.id}
                  href={`/board/${card.id}`}
                  className="block bg-gray-900 border border-gray-800 rounded-md p-3 hover:border-gray-700"
                >
                  <div className="flex justify-between">
                    <span className="text-sm">{card.title}</span>
                    <span className="text-xs text-gray-500">{card.status}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Recent Runs */}
        <section>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
            Recent Runs ({project._count.runs})
          </h2>
          {project.runs.length === 0 ? (
            <p className="text-gray-600 text-sm">No runs yet</p>
          ) : (
            <div className="space-y-2">
              {project.runs.map((run) => (
                <div
                  key={run.id}
                  className="bg-gray-900 border border-gray-800 rounded-md p-3"
                >
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-300 line-clamp-1">{run.plan}</span>
                    <span className="text-xs text-gray-500">{run.status}</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    {new Date(run.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Delete */}
        <section className="pt-8 border-t border-gray-800">
          <form action={deleteProject}>
            <input type="hidden" name="id" value={project.id} />
            <button
              type="submit"
              className="px-4 py-2 text-sm text-red-400 border border-red-400/30 hover:bg-red-400/10 rounded-md"
            >
              Delete Project
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
