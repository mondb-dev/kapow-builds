import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { runPipeline } from './orchestrator.js';
import { addRunLog, ensureRun, getRunLogs } from 'kapow-db/runs';
import { INTERNAL_AUTH_HEADER, isInternalRequestAuthorized } from 'kapow-shared';
import { finishRun, startRun, stopRun } from './run-control.js';

export interface RunEntry {
  status: 'running' | 'done' | 'failed';
  messages: string[];
  result?: unknown;
  createdAt: number;
  subscribers: Set<ServerResponse>;
}

// In-memory for SSE subscriber tracking only. Messages are also persisted to DB.
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

function requireInternalAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isInternalRequestAuthorized(req.headers)) {
    return true;
  }

  sendJson(res, 401, { error: 'Internal authorization required' }, req);
  return false;
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

  const {
    plan,
    runId: requestedRunId,
    projectId,
  } = body as { plan?: string; runId?: string; projectId?: string };

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
  const runSignal = startRun(runId);

  try {
    await ensureRun(runId, plan, typeof projectId === 'string' ? projectId : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: `Failed to initialize run: ${msg}` }, req);
    return;
  }

  runLog.set(runId, entry);

  // Respond immediately with runId
  sendJson(res, 202, { runId }, req);

  // Run pipeline asynchronously — broadcast to SSE + persist to DB
  const onProgress = (msg: string) => {
    messages.push(msg);
    process.stderr.write(msg + '\n');
    broadcastToRun(runId, { type: 'progress', message: msg, runId });
    // Persist to DB (fire-and-forget)
    addRunLog(runId, 'actions', msg, 'info').catch(() => {});
  };

  onProgress(`[${runId}] Pipeline started.`);

  runPipeline(runId, plan, onProgress, typeof projectId === 'string' ? projectId : undefined)
    .then((result) => {
      const status = result.success ? 'done' : 'failed';
      entry.status = status;
      entry.result = result;
      broadcastToRun(runId, { type: status, runId });
      finishRun(runId);

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
      addRunLog(runId, 'actions', `[${runId}] Unexpected error: ${msg}`, 'error').catch(() => {});
      broadcastToRun(runId, { type: 'failed', message: msg, runId });
      finishRun(runId);

      for (const sub of entry.subscribers) {
        try { sub.end(); } catch { /* ignore */ }
      }
      entry.subscribers.clear();
    });
}

async function handleRunStop(req: IncomingMessage, res: ServerResponse, runId: string) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' }, req);
    return;
  }

  if (!isValidRunId(runId)) {
    sendJson(res, 400, { error: 'Invalid runId' }, req);
    return;
  }

  let body: unknown = {};
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' }, req);
    return;
  }

  const reason = typeof (body as { reason?: string }).reason === 'string'
    ? (body as { reason?: string }).reason
    : 'Stopped by user.';

  const entry = runLog.get(runId);
  const stopped = stopRun(runId, reason);

  if (entry && stopped) {
    entry.status = 'failed';
    entry.messages.push(`[${runId}] ${reason}`);
    broadcastToRun(runId, { type: 'failed', message: reason, runId });
    addRunLog(runId, 'actions', `[${runId}] ${reason}`, 'warn').catch(() => {});
  }

  sendJson(res, 200, { ok: true, stopped }, req);
}

async function handleRunStatus(req: IncomingMessage, res: ServerResponse, runId: string) {
  if (!isValidRunId(runId)) {
    sendJson(res, 400, { error: 'Invalid runId' }, req);
    return;
  }

  // Check in-memory first (live runs)
  const entry = runLog.get(runId);
  if (entry) {
    sendJson(res, 200, { status: entry.status, messages: entry.messages }, req);
    return;
  }

  // Fall back to DB (survives restarts)
  try {
    const logs = await getRunLogs(runId);
    if (logs.length > 0) {
      sendJson(res, 200, {
        status: 'unknown',
        messages: logs.map((l) => l.message),
      }, req);
      return;
    }
  } catch { /* DB unavailable */ }

  sendJson(res, 404, { error: `No run found: ${runId}` }, req);
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
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      // CORS preflight
      if (method === 'OPTIONS') {
        const origin = getCorsOrigin(req);
        const headers: Record<string, string> = {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': `Content-Type, ${INTERNAL_AUTH_HEADER}`,
        };
        if (origin) headers['Access-Control-Allow-Origin'] = origin;
        res.writeHead(204, headers);
        res.end();
        return;
      }

      // POST /pipeline
      if (url === '/pipeline') {
        if (!requireInternalAuth(req, res)) return;
        await handlePipeline(req, res);
        return;
      }

      // GET /runs/:runId/status
      const statusMatch = url.match(/^\/runs\/([^/]+)\/status$/);
      if (statusMatch && method === 'GET') {
        if (!requireInternalAuth(req, res)) return;
        handleRunStatus(req, res, statusMatch[1]);
        return;
      }

      // GET /runs/:runId/stream
      const streamMatch = url.match(/^\/runs\/([^/]+)\/stream$/);
      if (streamMatch && method === 'GET') {
        if (!requireInternalAuth(req, res)) return;
        handleRunStream(req, res, streamMatch[1]);
        return;
      }

      const stopMatch = url.match(/^\/runs\/([^/]+)\/stop$/);
      if (stopMatch && method === 'POST') {
        if (!requireInternalAuth(req, res)) return;
        await handleRunStop(req, res, stopMatch[1]);
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

  server.listen(port, host, () => {
    process.stderr.write(`kapow-actions HTTP server listening on ${host}:${port}\n`);
  });

  return server;
}
