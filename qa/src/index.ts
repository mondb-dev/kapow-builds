import { createAgent } from 'kapow-shared';
import { runTaskQA } from './qa.js';
import type { TaskQARequest } from './types.js';

const agent = createAgent('qa', {
  requiresAI: true,
  bodyLimit: '50mb',
});

// Per-task QA endpoint
agent.app.post('/qa-task', async (req, res, next) => {
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

agent.start();
