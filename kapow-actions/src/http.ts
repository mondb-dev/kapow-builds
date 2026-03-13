import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { runPipeline } from './orchestrator.js';

export interface RunEntry {
  status: 'running' | 'done' | 'failed';
  messages: string[];
  result?: unknown;
  createdAt: number;
  // SSE subscribers waiting for this run
  subscribers: Set<ServerResponse>;
}

export const runLog = new Map<string, RunEntry>();

// Cleanup entries older than 1 hour, every 5 minutes
const RUN_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanupRunLog() {
  const now = Date.now();
  for (const [id, entry] of runLog) {
    if (now - entry.createdAt > RUN_TTL_MS) {
      for (const sub of entry.subscribers) {
        try { sub.end(); } catch { /* ignore */ }
      }
      runLog.delete(id);
    }
  }
}

setInterval(cleanupRunLog, CLEANUP_INTERVAL_MS).unref();

// CORS origin whitelist
function getAllowedOrigins(): string[] {
  const env = process.env.ALLOWED_ORIGINS ?? 'http://localhost:3001,http://localhost:3005';
  return env.split(',').map((o) => o.trim()).filter(Boolean);
}

function getCorsOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (!origin) return undefined;
  const allowed = getAllowedOrigins();
  return allowed.includes(origin) ? origin : undefined;
}

// RunId validation
function isValidRunId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown, req?: IncomingMessage) {
  const body = JSON.stringify(data);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (req) {
    const origin = getCorsOrigin(req);
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function broadcastToRun(runId: string, event: unknown) {
  const entry = runLog.get(runId);
  if (!entry) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const sub of entry.subscribers) {
    try { sub.write(line); } catch { entry.subscribers.delete(sub); }
  }
}

async function handlePipeline(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' }, req);
    return;
  }

  let body: unknown;
  try { body = await parseBody(req); }
  catch { sendJson(res, 400, { error: 'Invalid JSON' }, req); return; }

  const { plan, runId: requestedRunId } = body as { plan?: string; runId?: string };

  if (!plan || typeof plan !== 'string') {
    sendJson(res, 400, { error: 'plan is required' }, req);
    return;
  }

  if (plan.length > 100_000) {
    sendJson(res, 400, { error: 'Plan exceeds maximum length of 100,000 characters' }, req);
    return;
  }

  if (requestedRunId !== undefined) {
    if (typeof requestedRunId !== 'string' || !isValidRunId(requestedRunId)) {
      sendJson(res, 400, { error: 'Invalid runId: must match /^[a-zA-Z0-9_-]+$/' }, req);
      return;
    }
  }

  const runId = requestedRunId && typeof requestedRunId === 'string' ? requestedRunId : randomUUID();
  const messages: string[] = [];
  const entry: RunEntry = { status: 'running', messages, createdAt: Date.now(), subscribers: new Set() };
  runLog.set(runId, entry);

  // Respond immediately with runId
  sendJson(res, 202, { runId }, req);

  // Run pipeline asynchronously — broadcast progress to SSE subscribers
  const onProgress = (msg: string) => {
    messages.push(msg);
    process.stderr.write(msg + '\n');
    broadcastToRun(runId, { type: 'progress', message: msg, runId });
  };

  onProgress(`[${runId}] Pipeline started.`);

  runPipeline(runId, plan, onProgress)
    .then((result) => {
      const status = result.success ? 'done' : 'failed';
      entry.status = status;
      entry.result = result;
      broadcastToRun(runId, { type: status, runId });

      // Close SSE connections
      for (const sub of entry.subscribers) {
        try { sub.end(); } catch { /* ignore */ }
      }
      entry.subscribers.clear();
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      messages.push(`[${runId}] Unexpected error: ${msg}`);
      entry.status = 'failed';
      broadcastToRun(runId, { type: 'failed', message: msg, runId });

      for (const sub of entry.subscribers) {
        try { sub.end(); } catch { /* ignore */ }
      }
      entry.subscribers.clear();
    });
}

function handleRunStatus(req: IncomingMessage, res: ServerResponse, runId: string) {
  if (!isValidRunId(runId)) {
    sendJson(res, 400, { error: 'Invalid runId' }, req);
    return;
  }
  const entry = runLog.get(runId);
  if (!entry) {
    sendJson(res, 404, { error: `No run found: ${runId}` }, req);
    return;
  }
  sendJson(res, 200, { status: entry.status, messages: entry.messages }, req);
}

function handleRunStream(req: IncomingMessage, res: ServerResponse, runId: string) {
  if (!isValidRunId(runId)) {
    sendJson(res, 400, { error: 'Invalid runId' }, req);
    return;
  }
  const entry = runLog.get(runId);
  if (!entry) {
    sendJson(res, 404, { error: `No run found: ${runId}` }, req);
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  const origin = getCorsOrigin(req);
  if (origin) headers['Access-Control-Allow-Origin'] = origin;

  res.writeHead(200, headers);

  // Send already-received messages immediately
  for (const msg of entry.messages) {
    res.write(`data: ${JSON.stringify({ type: 'progress', message: msg, runId })}\n\n`);
  }

  // If already done, send terminal event and close
  if (entry.status === 'done' || entry.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: entry.status, runId })}\n\n`);
    res.end();
    return;
  }

  // Subscribe to future events
  entry.subscribers.add(res);

  req.on('close', () => {
    entry.subscribers.delete(res);
  });
}

export function createHttpServer(port = 3000) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      // CORS preflight
      if (method === 'OPTIONS') {
        const origin = getCorsOrigin(req);
        const headers: Record<string, string> = {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        };
        if (origin) headers['Access-Control-Allow-Origin'] = origin;
        res.writeHead(204, headers);
        res.end();
        return;
      }

      // POST /pipeline
      if (url === '/pipeline') {
        await handlePipeline(req, res);
        return;
      }

      // GET /runs/:runId/status
      const statusMatch = url.match(/^\/runs\/([^/]+)\/status$/);
      if (statusMatch && method === 'GET') {
        handleRunStatus(req, res, statusMatch[1]);
        return;
      }

      // GET /runs/:runId/stream
      const streamMatch = url.match(/^\/runs\/([^/]+)\/stream$/);
      if (streamMatch && method === 'GET') {
        handleRunStream(req, res, streamMatch[1]);
        return;
      }

      // Health check
      if (url === '/health' && method === 'GET') {
        sendJson(res, 200, { ok: true }, req);
        return;
      }

      sendJson(res, 404, { error: 'Not found' }, req);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`HTTP handler error: ${msg}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  server.listen(port, () => {
    process.stderr.write(`kapow-actions HTTP server listening on port ${port}\n`);
  });

  return server;
}
