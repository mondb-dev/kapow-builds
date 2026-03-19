import express, { Request, Response, NextFunction } from 'express';
import { runTaskQA } from './qa.js';
import type { TaskQARequest } from './types.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT ?? '3003', 10);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-qa' });
});

// Per-task QA endpoint
app.post('/qa-task', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as TaskQARequest;

    if (!body.runId || typeof body.runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!body.task || !body.task.id) {
      res.status(400).json({ error: 'task is required' });
      return;
    }
    if (!body.buildResult) {
      res.status(400).json({ error: 'buildResult is required' });
      return;
    }
    if (!body.architecture) {
      res.status(400).json({ error: 'architecture is required' });
      return;
    }

    console.log(`[${body.runId}] QA checking task ${body.task.id}...`);
    const result = await runTaskQA(body);
    console.log(
      `[${body.runId}] QA task ${body.task.id}: Passed=${result.passed}, Issues=${result.issues.length}`
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('QA error:', err);
  res.status(500).json({ error: err.message });
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is required');
  process.exit(1);
}
if (isNaN(PORT)) {
  console.error('FATAL: PORT must be numeric');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`kapow-qa listening on port ${PORT}`);
});
