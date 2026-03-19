import { createAgent } from 'kapow-shared';
import { buildTask, fixTask } from './builder.js';
import type { TaskBuildRequest, TaskFixRequest } from './types.js';

const agent = createAgent('builder', {
  requiresAI: true,
  bodyLimit: '50mb',
});

// Per-task build endpoint
agent.app.post('/build-task', async (req, res, next) => {
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
agent.app.post('/fix-task', async (req, res, next) => {
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

agent.start();
