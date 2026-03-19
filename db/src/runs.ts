import { prisma } from './client.js';
import type { RunStatus as PrismaRunStatus, LogLevel as PrismaLogLevel } from '@prisma/client';

export type RunStatus = 'pending' | 'planning' | 'building' | 'qa' | 'gate' | 'done' | 'failed';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const STATUS_TO_PRISMA: Record<RunStatus, PrismaRunStatus> = {
  pending: 'PENDING', planning: 'PLANNING', building: 'BUILDING',
  qa: 'QA', gate: 'GATE', done: 'DONE', failed: 'FAILED',
};

const LEVEL_TO_PRISMA: Record<LogLevel, PrismaLogLevel> = {
  debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR',
};

export interface RunRecord {
  id: string;
  projectId: string;
  plan: string;
  status: RunStatus;
  result: unknown;
  createdAt: Date;
  updatedAt: Date;
}

// ── Runs ─────────────────────────────────────────────────────────────

export async function createRun(projectId: string, plan: string): Promise<RunRecord> {
  const row = await prisma.run.create({
    data: { projectId, plan },
  });
  return { ...row, status: 'pending' };
}

export async function updateRunStatus(id: string, status: RunStatus, result?: unknown): Promise<void> {
  await prisma.run.update({
    where: { id },
    data: {
      status: STATUS_TO_PRISMA[status],
      ...(result !== undefined ? { result: JSON.parse(JSON.stringify(result)) } : {}),
    },
  });
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const row = await prisma.run.findUnique({ where: { id } });
  return row as unknown as RunRecord | null;
}

export async function getProjectRuns(projectId: string, limit = 20): Promise<RunRecord[]> {
  const rows = await prisma.run.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows as unknown as RunRecord[];
}

// ── Run Logs ─────────────────────────────────────────────────────────

export async function addRunLog(
  runId: string,
  service: string,
  message: string,
  level: LogLevel = 'info',
  metadata?: Record<string, unknown>,
): Promise<void> {
  await prisma.runLog.create({
    data: {
      runId,
      service,
      message,
      level: LEVEL_TO_PRISMA[level],
      metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
    },
  });
}

export async function getRunLogs(runId: string, limit = 200): Promise<Array<{
  id: string; service: string; level: string; message: string; createdAt: Date;
}>> {
  return prisma.runLog.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, service: true, level: true, message: true, createdAt: true },
  });
}

// ── Run Artifacts ────────────────────────────────────────────────────

export async function addRunArtifact(
  runId: string,
  taskId: string,
  path: string,
  type: string,
  sandboxPath: string,
  size?: number,
): Promise<void> {
  await prisma.runArtifact.create({
    data: { runId, taskId, path, type, sandboxPath, size },
  });
}

export async function getRunArtifacts(runId: string): Promise<Array<{
  id: string; taskId: string; path: string; type: string; sandboxPath: string; size: number | null;
}>> {
  return prisma.runArtifact.findMany({
    where: { runId },
    orderBy: { path: 'asc' },
  });
}
