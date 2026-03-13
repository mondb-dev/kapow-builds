import express, { Request, Response, NextFunction } from 'express';
import { build, fix } from './builder.js';
import type { BuildRequest, FixRequest } from './types.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT ?? '3002', 10);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-builder' });
});

app.post('/build', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runId, taskGraph } = req.body as BuildRequest;

    if (!runId || typeof runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!taskGraph || !taskGraph.tasks) {
      res.status(400).json({ error: 'taskGraph is required' });
      return;
    }

    console.log(`[${runId}] Building ${taskGraph.tasks.length} tasks...`);
    const result = await build(runId, taskGraph);
    console.log(`[${runId}] Build complete. ${result.artifacts.length} artifacts. Success: ${result.success}`);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/fix', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runId, taskGraph, previousBuildResult, delta, iteration } = req.body as FixRequest;

    if (!runId || typeof runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!taskGraph || !previousBuildResult || !delta) {
      res.status(400).json({ error: 'taskGraph, previousBuildResult, and delta are required' });
      return;
    }

    console.log(`[${runId}] Fixing (iteration ${iteration})...`);
    const result = await fix(runId, taskGraph, previousBuildResult, delta, iteration);
    console.log(`[${runId}] Fix complete. ${result.artifacts.length} artifacts.`);

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

app.listen(PORT, () => {
  console.log(`kapow-builder listening on port ${PORT}`);
});
