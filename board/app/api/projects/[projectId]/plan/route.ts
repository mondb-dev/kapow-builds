import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getInternalAuthHeaders } from '@/lib/internal';
import { userCanAccessProject } from '@/lib/authz';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), '..', 'uploads');

const PIPELINE_URL = process.env.KAPOW_ACTIONS_URL ?? process.env.PLANNER_URL ?? 'http://127.0.0.1:3000';

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
  const { brief, attachments } = body as {
    brief: string;
    attachments?: Array<{ id: string; name: string; filename: string; mimeType: string }>;
  };

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

  // Read text-based attachments and include as planner context
  const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/html']);
  const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'ts', 'js', 'py', 'rb', 'go', 'rs', 'java', 'sh', 'sql', 'graphql', 'proto', 'env', 'dockerfile', 'makefile']);
  let attachmentContext = '';
  if (attachments?.length) {
    const parts: string[] = [];
    for (const att of attachments) {
      const ext = att.filename.split('.').pop()?.toLowerCase() ?? '';
      const isText = TEXT_TYPES.has(att.mimeType) || TEXT_EXTS.has(ext);
      if (!isText) {
        parts.push(`[Attachment: ${att.name} (${att.mimeType}) — binary file, not included as text]`);
        continue;
      }
      const filePath = join(UPLOAD_DIR, att.filename);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, 'utf-8').slice(0, 50000);
        parts.push(`=== Attachment: ${att.name} ===\n${content}\n=== End ${att.name} ===`);
      } catch {
        parts.push(`[Attachment: ${att.name} — could not read]`);
      }
    }
    if (parts.length > 0) {
      attachmentContext = '\n\n--- Attached Files ---\n' + parts.join('\n\n');
    }
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
        plan: brief + attachmentContext,
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

    // Store full planner output for pipeline execution
    await db.project.update({
      where: { id: projectId },
      data: { planData: projectPlan as unknown as Record<string, unknown> },
    });

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
