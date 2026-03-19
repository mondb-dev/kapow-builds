import { createAgent } from 'kapow-shared';
import { createProjectPlan } from './planner.js';
import type { PlanRequest } from './types.js';

const agent = createAgent('planner', {
  requiresAI: true,
});

agent.app.post('/plan', async (req, res, next) => {
  try {
    const { runId, plan, recipes, preferences } = req.body as PlanRequest;

    if (!runId || typeof runId !== 'string') {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    if (!plan || typeof plan !== 'string') {
      res.status(400).json({ error: 'plan (client brief) is required' });
      return;
    }

    console.log(`[${runId}] Planning...`);
    const projectPlan = await createProjectPlan(runId, plan, recipes, preferences);
    const totalTasks = projectPlan.phases.reduce((sum, p) => sum + p.tasks.length, 0);
    console.log(`[${runId}] Plan complete: ${projectPlan.phases.length} phases, ${totalTasks} tasks`);

    res.json(projectPlan);
  } catch (err) {
    next(err);
  }
});

agent.start();
