import { prisma } from './client.js';
import type { ToolStatus as PrismaToolStatus } from '@prisma/client';

export type ToolStatus = 'researching' | 'building' | 'testing' | 'ready' | 'failed' | 'deprecated';

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
}

export interface ToolDoc {
  summary: string;
  usage: string;
  parameters: string;
  returns: string;
  examples: string[];
  caveats: string[];
  relatedTools: string[];
}

export interface ToolRecord {
  id: string;
  name: string;
  description: string;
  version: number;
  status: ToolStatus;
  parameters: ToolParameter[];
  returnType: string;
  implementation: string;
  testCode: string;
  tags: string[];
  doc: ToolDoc | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── Status mapping between app and Prisma enum ───────────────────────

const STATUS_TO_PRISMA: Record<ToolStatus, PrismaToolStatus> = {
  researching: 'RESEARCHING',
  building: 'BUILDING',
  testing: 'TESTING',
  ready: 'READY',
  failed: 'FAILED',
  deprecated: 'DEPRECATED',
};

const PRISMA_TO_STATUS: Record<PrismaToolStatus, ToolStatus> = {
  RESEARCHING: 'researching',
  BUILDING: 'building',
  TESTING: 'testing',
  READY: 'ready',
  FAILED: 'failed',
  DEPRECATED: 'deprecated',
};

function toToolRecord(row: {
  id: string; name: string; description: string; version: number;
  status: PrismaToolStatus; parameters: unknown; returnType: string;
  implementation: string; testCode: string; tags: string[];
  doc: unknown; createdBy: string; createdAt: Date; updatedAt: Date;
}): ToolRecord {
  return {
    ...row,
    status: PRISMA_TO_STATUS[row.status],
    parameters: row.parameters as ToolParameter[],
    doc: row.doc as ToolDoc | null,
  };
}

// ── Queries ──────────────────────────────────────────────────────────

export async function getAllTools(): Promise<ToolRecord[]> {
  const rows = await prisma.tool.findMany({ orderBy: { name: 'asc' } });
  return rows.map(toToolRecord);
}

export async function getReadyTools(): Promise<ToolRecord[]> {
  const rows = await prisma.tool.findMany({
    where: { status: 'READY' },
    orderBy: { name: 'asc' },
  });
  return rows.map(toToolRecord);
}

export async function getToolById(id: string): Promise<ToolRecord | null> {
  const row = await prisma.tool.findUnique({ where: { id } });
  return row ? toToolRecord(row) : null;
}

export async function queryTools(opts: {
  status?: ToolStatus;
  tags?: string[];
  search?: string;
}): Promise<ToolRecord[]> {
  const where: Record<string, unknown> = {};

  if (opts.status) {
    where.status = STATUS_TO_PRISMA[opts.status];
  }
  if (opts.tags && opts.tags.length > 0) {
    where.tags = { hasSome: opts.tags };
  }
  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: 'insensitive' } },
      { description: { contains: opts.search, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.tool.findMany({ where, orderBy: { name: 'asc' } });
  return rows.map(toToolRecord);
}

// ── Mutations ────────────────────────────────────────────────────────

export async function upsertTool(tool: Omit<ToolRecord, 'createdAt' | 'updatedAt'>): Promise<ToolRecord> {
  const row = await prisma.tool.upsert({
    where: { id: tool.id },
    create: {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      version: tool.version,
      status: STATUS_TO_PRISMA[tool.status],
      parameters: JSON.parse(JSON.stringify(tool.parameters)),
      returnType: tool.returnType,
      implementation: tool.implementation,
      testCode: tool.testCode,
      tags: tool.tags,
      doc: tool.doc ? JSON.parse(JSON.stringify(tool.doc)) : undefined,
      createdBy: tool.createdBy,
    },
    update: {
      name: tool.name,
      description: tool.description,
      version: tool.version,
      status: STATUS_TO_PRISMA[tool.status],
      parameters: JSON.parse(JSON.stringify(tool.parameters)),
      returnType: tool.returnType,
      implementation: tool.implementation,
      testCode: tool.testCode,
      tags: tool.tags,
      doc: tool.doc ? JSON.parse(JSON.stringify(tool.doc)) : undefined,
    },
  });
  return toToolRecord(row);
}

export async function updateToolStatus(id: string, status: ToolStatus): Promise<ToolRecord | null> {
  try {
    const row = await prisma.tool.update({
      where: { id },
      data: { status: STATUS_TO_PRISMA[status] },
    });
    return toToolRecord(row);
  } catch {
    return null;
  }
}

export async function deleteTool(id: string): Promise<boolean> {
  try {
    await prisma.tool.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}
