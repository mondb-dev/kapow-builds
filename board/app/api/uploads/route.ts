import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), '..', 'uploads');

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large (max 50MB)' }, { status: 400 });
  }

  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  const ext = file.name.split('.').pop() ?? '';
  const id = randomUUID();
  const filename = `${id}.${ext}`;
  const filepath = join(UPLOAD_DIR, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  writeFileSync(filepath, buffer);

  return NextResponse.json({
    id,
    name: file.name,
    size: file.size,
    mimeType: file.type,
    path: filepath,
    filename,
  }, { status: 201 });
}
