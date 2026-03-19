/**
 * File Handling for Communication Channels
 *
 * Supports receiving files/images from users and attaching
 * files to outgoing messages (e.g. screenshots, build artifacts).
 */
import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/kapow-uploads';

export interface IncomingFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  localPath: string;        // Saved to disk
  originalUrl?: string;     // Platform-specific URL (e.g. Slack file URL)
}

export interface OutgoingFile {
  name: string;
  content: Buffer;
  mimeType: string;
}

// ── Supported file types ─────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  // Documents
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
  // Code
  'application/json', 'application/xml', 'text/html', 'text/css',
  'application/javascript', 'text/typescript',
  // Archives
  'application/zip', 'application/gzip',
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export function isAllowedFile(mimeType: string, size: number): { ok: boolean; reason?: string } {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return { ok: false, reason: `File type ${mimeType} is not supported` };
  }
  if (size > MAX_FILE_SIZE) {
    return { ok: false, reason: `File too large (${(size / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB)` };
  }
  return { ok: true };
}

// ── Save uploaded file ───────────────────────────────────────────────

export function saveUploadedFile(
  name: string,
  content: Buffer,
  mimeType: string,
): IncomingFile {
  if (!existsSync(UPLOAD_DIR)) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  const id = randomUUID();
  const ext = extname(name) || mimeTypeToExt(mimeType);
  const filename = `${id}${ext}`;
  const localPath = join(UPLOAD_DIR, filename);

  writeFileSync(localPath, content);

  return {
    id,
    name,
    mimeType,
    size: content.length,
    localPath,
  };
}

function mimeTypeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
    'application/zip': '.zip',
  };
  return map[mime] ?? '';
}
