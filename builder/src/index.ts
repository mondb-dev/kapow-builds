import express, { Request, Response, NextFunction } from 'express';
import { buildTask, fixTask } from './builder.js';
import type { TaskBuildRequest, TaskFixRequest } from './types.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT ?? '3002', 10);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-builder' });
});

// Per-task build endpoint
app.post('/build-task', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as TaskBuildRequest;

    if (!body.runId || typeof body.runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!body.task || !body.task.id) {
      res.status(400).json({ error: 'task is required' });
      return;
    }
    if (!body.phase || !body.architecture) {
      res.status(400).json({ error: 'phase and architecture are required' });
      return;
    }

    console.log(`[${body.runId}] Building task ${body.task.id}...`);
    const result = await buildTask(body);
    console.log(`[${body.runId}] Task ${body.task.id} complete. Success: ${result.success}`);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Per-task fix endpoint
app.post('/fix-task', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as TaskFixRequest;

    if (!body.runId || typeof body.runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!body.task || !body.previousBuildResult || !body.delta) {
      res.status(400).json({ error: 'task, previousBuildResult, and delta are required' });
      return;
    }

    console.log(`[${body.runId}] Fixing task ${body.task.id} (iteration ${body.iteration})...`);
    const result = await fixTask(body);
    console.log(`[${body.runId}] Task ${body.task.id} fix complete.`);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Builder error:', err);
  res.status(500).json({ error: err.message });
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is required');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`kapow-builder listening on port ${PORT}`);
});
