import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getInternalAuthHeaders } from '@/lib/internal';
import { userCanAccessProject } from '@/lib/authz';

const PIPELINE_URL = process.env.KAPOW_ACTIONS_URL ?? process.env.PLANNER_URL ?? 'http://localhost:3000';

interface Params {
  params: Promise<{ projectId: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId } = await params;
  const body = await req.json();
  const { brief } = body as { brief: string; attachments?: unknown[] };

  if (!(await userCanAccessProject(session.user.id, projectId)) && !session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!brief?.trim()) {
    return NextResponse.json({ error: 'Brief is required' }, { status: 400 });
  }

  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  try {
    // Call the planner service
    const planRes = await fetch(`${PIPELINE_URL}/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getInternalAuthHeaders(),
      },
      body: JSON.stringify({
        runId: `plan-${projectId}`,
        plan: brief,
      }),
      signal: AbortSignal.timeout(180_000),
    });

    if (!planRes.ok) {
      const text = await planRes.text().catch(() => 'Unknown error');
      return NextResponse.json({ error: `Planner failed: ${text}` }, { status: 502 });
    }

    const projectPlan = await planRes.json() as {
      phases: Array<{
        id: string;
        name: string;
        description: string;
        tasks: Array<{
          id: string;
          description: string;
          type: string;
          acceptanceCriteria: string[];
        }>;
      }>;
      architecture?: { overview?: string; techStack?: string };
    };

    // Create cards for each task
    const cards = [];
    for (const phase of projectPlan.phases ?? []) {
      for (const task of phase.tasks ?? []) {
        const description = [
          task.description,
          '',
          `Phase: ${phase.name}`,
          `Type: ${task.type}`,
          '',
          'Acceptance Criteria:',
          ...task.acceptanceCriteria.map((ac) => `  - ${ac}`),
        ].join('\n');

        const card = await db.card.create({
          data: {
            title: `[${phase.name}] ${task.description.slice(0, 150)}`,
            description,
            projectId,
            phaseId: phase.id,
            taskId: task.id,
            creatorId: session.user.id,
          },
        });
        cards.push(card);
      }
    }

    // Update project description with architecture info if available
    if (projectPlan.architecture?.overview) {
      await db.project.update({
        where: { id: projectId },
        data: {
          description: [
            project.description ?? '',
            '',
            '--- Architecture ---',
            projectPlan.architecture.overview,
            projectPlan.architecture.techStack ? `Tech: ${projectPlan.architecture.techStack}` : '',
          ].filter(Boolean).join('\n'),
        },
      });
    }

    return NextResponse.json({
      plan: projectPlan,
      cardsCreated: cards.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[plan] Error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
