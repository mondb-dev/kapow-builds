import { prisma } from './client.js';
import type { InfraType, InfraStatus } from '@prisma/client';

export type { InfraType, InfraStatus };

export interface InfraRecord {
  id: string;
  type: InfraType;
  provider: string;
  name: string;
  resourceId: string | null;
  url: string | null;
  region: string | null;
  status: InfraStatus;
  lastChecked: Date | null;
  projectId: string | null;
  runId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordInfraArgs {
  type: InfraType;
  provider: string;
  name: string;
  resourceId?: string;
  url?: string;
  region?: string;
  projectId?: string;
  runId?: string;
}

/** Upsert an infra resource. Keyed on (type, name) — safe to call repeatedly. */
export async function recordInfra(args: RecordInfraArgs): Promise<InfraRecord> {
  return prisma.infraResource.upsert({
    where: { type_name: { type: args.type, name: args.name } },
    create: {
      type: args.type,
      provider: args.provider,
      name: args.name,
      resourceId: args.resourceId,
      url: args.url,
      region: args.region,
      projectId: args.projectId,
      runId: args.runId,
      status: 'ACTIVE',
    },
    update: {
      url: args.url ?? undefined,
      resourceId: args.resourceId ?? undefined,
      region: args.region ?? undefined,
      projectId: args.projectId ?? undefined,
      runId: args.runId ?? undefined,
      status: 'ACTIVE',
    },
  });
}

export interface InfraWithProject extends InfraRecord {
  projectName: string | null;
}

/** Load all infra resources, optionally filtered by projectId. */
export async function listInfra(projectId?: string): Promise<InfraWithProject[]> {
  const rows = await prisma.infraResource.findMany({
    where: projectId ? { projectId } : undefined,
    include: { project: { select: { name: true } } },
    orderBy: [{ provider: 'asc' }, { type: 'asc' }, { name: 'asc' }],
  });
  return rows.map((r) => ({ ...r, projectName: r.project?.name ?? null }));
}

/** Mark an infra resource as deleted. */
export async function markInfraDeleted(type: InfraType, name: string): Promise<void> {
  await prisma.infraResource.updateMany({
    where: { type, name },
    data: { status: 'DELETED' },
  });
}

/** Update live status after a health check. */
export async function updateInfraStatus(
  id: string,
  status: InfraStatus,
): Promise<void> {
  await prisma.infraResource.update({
    where: { id },
    data: { status, lastChecked: new Date() },
  });
}
