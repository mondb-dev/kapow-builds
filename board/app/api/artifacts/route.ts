import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, basename, extname, resolve } from 'path';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

const SANDBOX_BASE = process.env.SANDBOX_BASE ?? '/tmp/kapow';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
};

/**
 * GET /api/artifacts?runId=xxx&path=yyy
 * Serves a file from the sandbox for download.
 * Resolves the actual sandbox directory from the RunArtifact record,
 * since sandbox dirs use {runId}-{taskId} naming, not just {runId}.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const runId = req.nextUrl.searchParams.get('runId');
  const filePath = req.nextUrl.searchParams.get('path');

  if (!runId || !filePath) {
    return NextResponse.json({ error: 'runId and path are required' }, { status: 400 });
  }

  // Prevent path traversal
  if (filePath.includes('..') || filePath.startsWith('/')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  // Look up the artifact record to get the actual sandboxPath
  const artifact = await db.runArtifact.findFirst({
    where: { runId, path: filePath },
    select: { sandboxPath: true },
  });

  // Use sandboxPath from DB if available, fall back to convention
  const sandboxDir = artifact?.sandboxPath || join(SANDBOX_BASE, runId);
  const fullPath = join(sandboxDir, filePath);

  // Ensure resolved path is within the sandbox base
  const resolved = resolve(fullPath);
  const sandboxRoot = resolve(sandboxDir);
  if (!resolved.startsWith(sandboxRoot + '/') && resolved !== sandboxRoot) {
    return NextResponse.json({ error: 'Path traversal blocked' }, { status: 403 });
  }

  // Also verify it's within the global sandbox base
  const globalRoot = resolve(SANDBOX_BASE);
  if (!resolved.startsWith(globalRoot + '/')) {
    return NextResponse.json({ error: 'Path traversal blocked' }, { status: 403 });
  }

  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const stat = statSync(fullPath);
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'Not a file' }, { status: 400 });
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const fileName = basename(filePath);
  const content = readFileSync(fullPath);

  return new NextResponse(content, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': stat.size.toString(),
    },
  });
}
