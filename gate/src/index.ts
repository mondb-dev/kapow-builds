import { createAgent } from 'kapow-shared';
import { evaluate } from './gate.js';
import type { GateRequest } from './types.js';

const agent = createAgent('gate', {
  requiresAI: true,
});

agent.app.post('/gate', async (req, res, next) => {
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

agent.start();
