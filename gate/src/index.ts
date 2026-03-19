import express, { Request, Response, NextFunction } from 'express';
import { evaluate } from './gate.js';
import type { GateRequest } from './types.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT ?? '3004', 10);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'kapow-gate' });
});

app.post('/gate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { runId, qaResult, iteration, artifacts } = req.body as GateRequest;

    if (!runId || typeof runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!qaResult) {
      res.status(400).json({ error: 'qaResult is required' });
      return;
    }
    if (typeof iteration !== 'number' || iteration < 1 || iteration > 10) {
      res.status(400).json({ error: 'iteration must be a number between 1 and 10' });
      return;
    }
    if (typeof qaResult.passed !== 'boolean' || !Array.isArray(qaResult.issues)) {
      res.status(400).json({ error: 'qaResult must have boolean passed and array issues' });
      return;
    }

    console.log(
      `[${runId}] Gate check: passed=${qaResult.passed}, iteration=${iteration}, issues=${qaResult.issues.length}`
    );

    const result = await evaluate(runId, qaResult, iteration, artifacts);

    console.log(`[${runId}] Gate signal: ${result.ciSignal}`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Gate error:', err);
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
  console.log(`kapow-gate listening on port ${PORT}`);
});
