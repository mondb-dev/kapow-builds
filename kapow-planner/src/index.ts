import express, { Request, Response, NextFunction } from 'express';
import { validateAndPlan } from './planner.js';
import type { PlanRequest } from './types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT ?? '3001', 10);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-planner' });
});

app.post('/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runId, plan } = req.body as PlanRequest;

    if (!runId || typeof runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!plan || typeof plan !== 'string') {
      res.status(400).json({ error: 'plan is required' });
      return;
    }

    console.log(`[${runId}] Planning...`);
    const taskGraph = await validateAndPlan(runId, plan);
    console.log(`[${runId}] Plan complete: ${taskGraph.tasks.length} tasks`);

    res.json(taskGraph);
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Planner error:', err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`kapow-planner listening on port ${PORT}`);
});
