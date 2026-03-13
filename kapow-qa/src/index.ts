import express, { Request, Response, NextFunction } from 'express';
import { runQA } from './qa.js';
import type { QARequest } from './types.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT ?? '3003', 10);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-qa' });
});

app.post('/qa', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runId, taskGraph, buildResult } = req.body as QARequest;

    if (!runId || typeof runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!taskGraph || !buildResult) {
      res.status(400).json({ error: 'taskGraph and buildResult are required' });
      return;
    }
    if (!Array.isArray(taskGraph.tasks)) {
      res.status(400).json({ error: 'taskGraph.tasks must be an array' });
      return;
    }

    console.log(`[${runId}] Running QA against ${taskGraph.tasks.length} tasks...`);
    const result = await runQA(runId, taskGraph, buildResult);
    console.log(
      `[${runId}] QA complete. Passed: ${result.passed}. Issues: ${result.issues.length}`
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
