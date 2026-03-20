import express, { Request, Response, NextFunction } from 'express';
import { researchTool } from './researcher.js';
import { buildTool } from './implementer.js';
import { handleToolRequest } from './request-handler.js';
import { generateDoc } from './doc-generator.js';
import { loadTools, getReadyTools, getToolById, queryTools, upsertTool } from './registry.js';
import { seedCoreTools } from './seed-tools.js';
import type { ResearchRequest, BuildToolRequest, ToolQuery, ToolRequest } from './types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT ?? '3006', 10);

function getScopedKey(key: string): string | undefined {
  const serviceName = process.env.SERVICE_NAME?.trim().toUpperCase().replace(/-/g, '_');
  if (!serviceName) return undefined;
  return process.env[`${serviceName}_${key}`];
}

// ── Health ───────────────────────────────────────────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  const tools = await loadTools();
  const ready = tools.filter((t) => t.status === 'ready').length;
  res.json({
    status: 'ok',
    service: 'kapow-technician',
    tools: { total: tools.length, ready },
  });
});

// ── Tool Registry (read endpoints — used by all agents) ─────────────

app.get('/tools', async (req: Request, res: Response) => {
  const query: ToolQuery = {
    status: req.query.status ? String(req.query.status) as ToolQuery['status'] : undefined,
    tags: req.query.tags ? String(req.query.tags).split(',') : undefined,
    search: req.query.search ? String(req.query.search) : undefined,
  };
  res.json(await queryTools(query));
});

app.get('/tools/ready', async (_req: Request, res: Response) => {
  res.json(await getReadyTools());
});

app.get('/tools/:id', async (req: Request, res: Response) => {
  const tool = await getToolById(String(req.params.id));
  if (!tool) {
    res.status(404).json({ error: 'Tool not found' });
    return;
  }
  res.json(tool);
});

// ── Tool Request (the main flow — any agent calls this) ──────────────

app.post('/request-tool', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as ToolRequest;

    if (!body.runId || typeof body.runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!body.need || typeof body.need !== 'string') {
      res.status(400).json({ error: 'need is required' });
      return;
    }
    if (!body.requestingAgent || typeof body.requestingAgent !== 'string') {
      res.status(400).json({ error: 'requestingAgent is required' });
      return;
    }

    console.log(`[${body.runId}] Tool request from ${body.requestingAgent}: ${body.need.slice(0, 100)}...`);

    const result = await handleToolRequest(body);

    const action = result.outcome.action;
    if (action === 'found_existing') {
      console.log(`[${body.runId}] → Matched existing tool: ${result.outcome.tool.name}`);
    } else if (action === 'created_new') {
      console.log(`[${body.runId}] → Created new tool: ${result.outcome.tool.name}`);
    } else if (action === 'updated_existing') {
      console.log(`[${body.runId}] → Updated tool: ${result.outcome.tool.name}`);
    } else if (action === 'decoupled') {
      console.log(`[${body.runId}] → Decoupled into: ${result.outcome.tools.map((t) => t.name).join(', ')}`);
    } else {
      console.log(`[${body.runId}] → Request failed: ${result.outcome.error}`);
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Direct Research endpoint ─────────────────────────────────────────

app.post('/research', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as ResearchRequest;

    if (!body.runId || typeof body.runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!body.need || typeof body.need !== 'string') {
      res.status(400).json({ error: 'need is required' });
      return;
    }

    console.log(`[${body.runId}] Researching tool: ${body.need.slice(0, 100)}...`);
    const result = await researchTool(body);
    console.log(`[${body.runId}] Research complete: ${result.toolName} (${result.estimatedComplexity})`);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Direct Build endpoint ────────────────────────────────────────────

app.post('/build', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as BuildToolRequest;

    if (!body.runId || typeof body.runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!body.research || !body.research.toolName) {
      res.status(400).json({ error: 'research spec is required' });
      return;
    }

    console.log(`[${body.runId}] Building tool: ${body.research.toolName}...`);
    const result = await buildTool(body);

    if (result.success) {
      result.tool.doc = await generateDoc(result.tool);
      await upsertTool(result.tool);
    }

    console.log(`[${body.runId}] Build ${result.success ? 'succeeded' : 'failed'}: ${result.toolId}`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Regenerate docs for a tool ───────────────────────────────────────

app.post('/tools/:id/regenerate-docs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tool = await getToolById(String(req.params.id));
    if (!tool) {
      res.status(404).json({ error: 'Tool not found' });
      return;
    }

    console.log(`Regenerating docs for ${tool.name}...`);
    const updatedDoc = await generateDoc(tool);
    await upsertTool({ ...tool, doc: updatedDoc });

    res.json({ ...tool, doc: updatedDoc });
  } catch (err) {
    next(err);
  }
});

// ── Error handler ────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Technician error:', err);
  res.status(500).json({ error: err.message });
});

const aiProvider = (process.env.AI_PROVIDER ?? 'anthropic').toLowerCase();
const hasAIKey = aiProvider === 'gemini' || aiProvider === 'google'
  ? Boolean(getScopedKey('GEMINI_API_KEY') || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
  : Boolean(getScopedKey('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY);

if (!hasAIKey) {
  console.error(
    aiProvider === 'gemini' || aiProvider === 'google'
      ? 'FATAL: GEMINI_API_KEY or GOOGLE_API_KEY is required'
      : 'FATAL: ANTHROPIC_API_KEY is required'
  );
  process.exit(1);
}

// Seed core tools on first boot, then start server
seedCoreTools().then(async () => {
  app.listen(PORT, async () => {
    const tools = await loadTools();
    console.log(`kapow-technician listening on port ${PORT} (${tools.filter((t) => t.status === 'ready').length} tools ready)`);
  });
});
