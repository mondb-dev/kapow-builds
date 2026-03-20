import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type ToolDoc = {
  summary?: string;
  usage?: string;
  parameters?: string;
  returns?: string;
  examples?: string[];
  caveats?: string[];
  relatedTools?: string[];
};

const toolStatusColors: Record<string, string> = {
  READY: 'text-green-400 bg-green-400/10 border-green-400/20',
  RESEARCHING: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  BUILDING: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  TESTING: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  FAILED: 'text-red-400 bg-red-400/10 border-red-400/20',
  DEPRECATED: 'text-gray-400 bg-gray-400/10 border-gray-400/20',
};

function asToolDoc(value: unknown): ToolDoc | null {
  if (!value || typeof value !== 'object') return null;
  return value as ToolDoc;
}

function getToolParameterCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export default async function KnowledgePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const [tools, recipes] = await Promise.all([
    db.tool.findMany({
      orderBy: [
        { status: 'asc' },
        { name: 'asc' },
      ],
    }),
    db.recipe.findMany({
      orderBy: [
        { category: 'asc' },
        { name: 'asc' },
      ],
    }),
  ]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/board" className="text-gray-400 hover:text-white text-sm">
            ← Board
          </Link>
          <h1 className="text-lg font-semibold">Team Knowledge</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-8">
        <section>
          <div className="flex items-end justify-between gap-4 mb-4">
            <div>
              <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Shared Tools</h2>
              <p className="text-sm text-gray-500 mt-1">Technician-managed tools available to the team and agents.</p>
            </div>
            <div className="text-xs text-gray-500">{tools.length} total</div>
          </div>

          {tools.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-500">
              No tools in the registry yet.
            </div>
          ) : (
            <div className="space-y-3">
              {tools.map((tool) => {
                const doc = asToolDoc(tool.doc);
                return (
                  <div key={tool.id} className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-3 flex-wrap">
                          <h3 className="text-base font-semibold text-white">{tool.name}</h3>
                          <span className={`rounded border px-2 py-0.5 text-xs font-medium ${toolStatusColors[tool.status] ?? toolStatusColors.READY}`}>
                            {tool.status.toLowerCase()}
                          </span>
                          <span className="text-xs text-gray-500">v{tool.version}</span>
                        </div>
                        <p className="mt-2 text-sm text-gray-300">{tool.description}</p>
                        {doc?.summary && (
                          <p className="mt-2 text-sm text-gray-400">{doc.summary}</p>
                        )}
                      </div>
                      <div className="text-right text-xs text-gray-500 whitespace-nowrap">
                        <div>{getToolParameterCount(tool.parameters)} params</div>
                        <div className="mt-1">{new Date(tool.updatedAt).toLocaleDateString()}</div>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {tool.tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-gray-800 px-2.5 py-1 text-xs text-gray-300">
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-lg bg-gray-950/70 p-3">
                        <div className="text-xs uppercase tracking-wide text-gray-500">Returns</div>
                        <div className="mt-1 text-sm text-gray-300">{tool.returnType}</div>
                      </div>
                      <div className="rounded-lg bg-gray-950/70 p-3">
                        <div className="text-xs uppercase tracking-wide text-gray-500">Implementation</div>
                        <div className="mt-1 text-sm font-mono text-gray-300 break-all">{tool.implementation}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-end justify-between gap-4 mb-4">
            <div>
              <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Shared Recipes</h2>
              <p className="text-sm text-gray-500 mt-1">Reusable guidance captured from previous successful work.</p>
            </div>
            <div className="text-xs text-gray-500">{recipes.length} total</div>
          </div>

          {recipes.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-6 text-sm text-gray-500">
              No recipes saved yet.
            </div>
          ) : (
            <div className="space-y-3">
              {recipes.map((recipe) => (
                <div key={recipe.id} className="rounded-xl border border-gray-800 bg-gray-900 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <h3 className="text-base font-semibold text-white">{recipe.name}</h3>
                        <span className="rounded border border-blue-400/20 bg-blue-400/10 px-2 py-0.5 text-xs font-medium text-blue-300">
                          {recipe.category}
                        </span>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-gray-300">{recipe.content}</p>
                    </div>
                    <div className="text-right text-xs text-gray-500 whitespace-nowrap">
                      <div>source</div>
                      <div className="mt-1 font-mono">{recipe.source}</div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {recipe.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-gray-800 px-2.5 py-1 text-xs text-gray-300">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
